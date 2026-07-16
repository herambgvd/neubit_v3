package localauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/neubit/gokernel/auth"
	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/nvr/internal/store"
)

// Caller is the unified authenticated caller the node's management API sees,
// regardless of which of the three credential kinds authenticated the request
// (spec §5.4). One Authenticate middleware resolves the request to exactly one
// Caller and stashes it on the context.
//
//   - Kind "local"   — a standalone-console session; Role is the local role
//     (admin|operator|viewer) and Subject is the local user id.
//   - Kind "central" — a core-minted access JWT; Perms carries the vms.* grants
//     (or "*") and Subject is the user id.
//   - Kind "node"    — the node's own long-lived credential (federation); Subject
//     is the node id.
type Caller struct {
	Kind    string   // "local" | "central" | "node"
	Subject string   // user id (local/central) or node id (node)
	Perms   []string // central grants (empty for local/node)
	Role    string   // local role (empty for central/node)
}

// grantsPerm reports whether a central caller holds a permission ("*" grants all).
func (c Caller) grantsPerm(perm string) bool {
	for _, p := range c.Perms {
		if p == auth.Wildcard || p == perm {
			return true
		}
	}
	return false
}

type callerCtxKey struct{}

// CallerFrom returns the Caller stored by Authenticate. The bool is false if the
// request did not pass through Authenticate.
func CallerFrom(ctx context.Context) (Caller, bool) {
	c, ok := ctx.Value(callerCtxKey{}).(Caller)
	return c, ok
}

// SessionResolver is the local-session lookup Authenticate needs (satisfied by
// *localauth.Service via ResolveSession).
type SessionResolver interface {
	ResolveSession(ctx context.Context, token string) (store.LocalUser, error)
}

// IdentityReader exposes the node's self so the node-credential branch can check
// enrollment state (satisfied by *sqlitestore.DB via GetNodeIdentity).
type IdentityReader interface {
	GetNodeIdentity(ctx context.Context) (store.NodeIdentity, error)
}

// Authenticator resolves any of the three node credential kinds to a Caller.
type Authenticator struct {
	sessions SessionResolver
	verifier *auth.Verifier
	identity IdentityReader
}

// NewAuthenticator wires the dual-mode middleware. sessions verifies local
// bearers, verifier validates central access JWTs, identity gates the node
// credential on enroll_state.
func NewAuthenticator(sessions SessionResolver, verifier *auth.Verifier, identity IdentityReader) *Authenticator {
	return &Authenticator{sessions: sessions, verifier: verifier, identity: identity}
}

// Authenticate is the dual-mode chi middleware (spec §5.4). It resolves the
// request to a unified Caller, trying in order:
//
//  1. Local session — an opaque Bearer looked up in local_sessions.
//  2. Central JWT — a core-minted access token verified with the shared secret.
//  3. Node credential — an X-Node-Credential header (presence + enroll_state).
//
// No usable credential → 401. A media token (sub_type "media") presented on the
// management API is ALWAYS rejected here (401) — it is a read-only streaming
// credential, never a management one.
func (a *Authenticator) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		token := bearer(r)

		// A media token must never be accepted on the management API, whichever
		// header it arrives in. Detect it up front so it can't be mistaken for a
		// local opaque bearer or slip through any branch.
		if isMediaToken(token) {
			kerr.Write(w, kerr.Unauthorized("media tokens are not accepted on the management API"))
			return
		}

		// 1) LOCAL SESSION — opaque bearer resolved against local_sessions.
		if token != "" && a.sessions != nil {
			if user, err := a.sessions.ResolveSession(ctx, token); err == nil {
				c := Caller{Kind: "local", Subject: user.ID, Role: user.Role}
				next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, callerCtxKey{}, c)))
				return
			}
		}

		// 2) CENTRAL JWT — a core-minted access token (same verifier the existing
		//    streams/recording routes use).
		if token != "" && a.verifier != nil {
			if p, err := a.verifier.Verify(token); err == nil {
				perms := p.Permissions
				if p.IsSuperadmin {
					// A super-admin grants everything; carry the wildcard so RequirePerm
					// treats it like the "*" grant.
					perms = append([]string{auth.Wildcard}, perms...)
				}
				c := Caller{Kind: "central", Subject: p.UserID.String(), Perms: perms}
				next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, callerCtxKey{}, c)))
				return
			}
		}

		// 3) NODE CREDENTIAL — presented in X-Node-Credential. Full signature
		//    verification lands with enrollment (Task 3.3); for now accept on
		//    presence + an enrolled node identity.
		if cred := strings.TrimSpace(r.Header.Get("X-Node-Credential")); cred != "" {
			if a.nodeCredentialOK(ctx) {
				c := Caller{Kind: "node", Subject: a.nodeID(ctx)}
				next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, callerCtxKey{}, c)))
				return
			}
		}

		kerr.Write(w, kerr.Unauthorized("missing or invalid node credentials"))
	})
}

// nodeCredentialOK accepts the node credential only when the node is enrolled.
// (Signature verification is Task 3.3; this is the stub acceptance the plan calls
// for.) A store error or non-enrolled node → not OK.
func (a *Authenticator) nodeCredentialOK(ctx context.Context) bool {
	if a.identity == nil {
		return false
	}
	ident, err := a.identity.GetNodeIdentity(ctx)
	if err != nil {
		return false
	}
	return ident.EnrollState == "enrolled"
}

func (a *Authenticator) nodeID(ctx context.Context) string {
	if a.identity == nil {
		return ""
	}
	if ident, err := a.identity.GetNodeIdentity(ctx); err == nil {
		return ident.ID
	}
	return ""
}

// RequireLocalRole gates a route on a minimum LOCAL role (admin ⊇ operator ⊇
// viewer). Central/node callers are not local, so they do not satisfy a local-role
// gate — use RequirePerm for those. Apply after Authenticate.
func RequireLocalRole(min string) func(http.Handler) http.Handler {
	want := roleRank(min)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, ok := CallerFrom(r.Context())
			if !ok {
				kerr.Write(w, kerr.Unauthorized("missing node credentials"))
				return
			}
			if c.Kind != "local" || roleRank(c.Role) < want {
				kerr.Write(w, kerr.Forbidden("requires local role: "+min))
				return
			}
			next.ServeHTTP(w, r.WithContext(r.Context()))
		})
	}
}

// RequirePerm gates a route on a permission. A central caller must grant it (or
// "*"); a local caller satisfies it via role→perm mapping (admin ⊇ operator ⊇
// viewer); the node credential (acting as the node itself) is trusted for the
// management API. Apply after Authenticate.
func RequirePerm(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, ok := CallerFrom(r.Context())
			if !ok {
				kerr.Write(w, kerr.Unauthorized("missing node credentials"))
				return
			}
			if !callerGrants(c, perm) {
				kerr.Write(w, kerr.Forbidden("missing permission: "+perm))
				return
			}
			next.ServeHTTP(w, r.WithContext(r.Context()))
		})
	}
}

// callerGrants maps a Caller to a permission decision:
//   - central: holds the perm or "*".
//   - local:   the fixed role→perm mapping (writes need operator+, everything else
//     viewer+; admin grants all).
//   - node:    the node acting as itself is trusted on its own management API.
func callerGrants(c Caller, perm string) bool {
	switch c.Kind {
	case "central":
		return c.grantsPerm(perm)
	case "local":
		return roleRank(c.Role) >= requiredRankForPerm(perm)
	case "node":
		return true
	default:
		return false
	}
}

// roleRank orders the local roles (admin ⊇ operator ⊇ viewer). An unknown role
// ranks below viewer so it never satisfies a gate.
func roleRank(role string) int {
	switch role {
	case "admin":
		return 3
	case "operator":
		return 2
	case "viewer":
		return 1
	default:
		return 0
	}
}

// requiredRankForPerm maps a vms.* permission to the minimum local role that
// holds it. Reads (*.read / *.view) need viewer; everything else (control/manage/
// write mutations) needs operator; admin grants everything by rank.
func requiredRankForPerm(perm string) int {
	if strings.HasSuffix(perm, ".read") || strings.HasSuffix(perm, ".view") {
		return roleRank("viewer")
	}
	return roleRank("operator")
}

// bearer extracts the token from an "Authorization: Bearer <token>" header
// (case-insensitive scheme), or "" when absent — same shape as the kernel's own
// bearer parse (unexported there, so kept local).
func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

// isMediaToken reports whether the bearer is a JWT whose payload carries
// sub_type:"media" (a streaming credential). Decoded WITHOUT verifying the
// signature — we only need to recognise the kind so we can reject it; a forged
// media token is still rejected (it can't pass the central verifier either).
func isMediaToken(token string) bool {
	if token == "" {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		SubType string `json:"sub_type"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return false
	}
	return claims.SubType == "media"
}
