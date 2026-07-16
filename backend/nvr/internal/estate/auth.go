package estate

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/store"
)

// mountAuth wires the local-auth surface the standalone box UI logs in against
// (spec §6.1 "Node self" / §6.1 local-auth). Two groups:
//
//	POST /estate/auth/login   — PUBLIC-within-estate: the login endpoint itself
//	POST /estate/auth/logout    cannot require an already-authenticated caller.
//
//	GET|POST      /estate/local-users        — manage operator accounts,
//	GET|PATCH|DEL /estate/local-users/{id}      ADMIN local role only.
//
// login/logout are mounted OUTSIDE the estate Authenticate middleware (they run
// before a session exists / to tear one down); local-user management is INSIDE
// it (the parent /estate route already applies Authenticate) and additionally
// gated on RequireLocalRole("admin"). Writes record an audit_log row.
func mountAuth(r chi.Router, d *Deps) {
	h := &authHandler{d: d}
	r.Route("/local-users", func(rr chi.Router) {
		rr.Use(localauth.RequireLocalRole("admin"))
		rr.Get("/", h.listUsers)
		rr.Post("/", h.createUser)
		rr.Get("/{id}", h.getUser)
		rr.Patch("/{id}", h.updateUser)
		rr.Delete("/{id}", h.deleteUser)
	})
}

// mountAuthPublic wires login/logout, which must NOT sit behind the estate
// Authenticate middleware — login precedes any session and logout only needs the
// raw bearer to revoke. Mounted as a sibling of the authenticated /estate tree.
func mountAuthPublic(r chi.Router, d *Deps) {
	h := &authHandler{d: d}
	r.Post("/auth/login", h.login)
	r.Post("/auth/logout", h.logout)
}

type authHandler struct{ d *Deps }

// ── login / logout ───────────────────────────────────────────────────────────

type loginBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// login verifies local credentials and returns an opaque session bearer the
// dual-mode middleware accepts. Lockout/rate-limit live in the Service; this
// handler maps its coarse errors to 401 (never leaking which check failed).
func (h *authHandler) login(w http.ResponseWriter, r *http.Request) {
	var body loginBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if strings.TrimSpace(body.Username) == "" || body.Password == "" {
		kerr.Write(w, kerr.BadRequest("username and password are required"))
		return
	}

	token, user, err := h.d.Auth.Login(r.Context(), body.Username, body.Password)
	if err != nil {
		if errors.Is(err, localauth.ErrLocked) {
			// Distinct signal so the UI can show a back-off message; still no
			// credential detail.
			kerr.Write(w, kerr.Unauthorized("account temporarily locked"))
			return
		}
		if errors.Is(err, localauth.ErrInvalidCredentials) || errors.Is(err, localauth.ErrInactive) {
			kerr.Write(w, kerr.Unauthorized("invalid username or password"))
			return
		}
		kerr.Write(w, kerr.Internal("login failed"))
		return
	}

	uname := user.Username
	h.audit(r, &uname, "local_user.login", user.ID)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user": map[string]any{
			"id":                   user.ID,
			"username":             user.Username,
			"role":                 user.Role,
			"must_change_password": user.MustChangePassword,
		},
	})
}

// logout revokes the session backing the presented bearer (idempotent — an
// unknown/absent token is a no-op 204).
func (h *authHandler) logout(w http.ResponseWriter, r *http.Request) {
	if token := bearerToken(r); token != "" {
		_ = h.d.Auth.Logout(r.Context(), token)
	}
	w.WriteHeader(http.StatusNoContent)
}

// bearerToken extracts an "Authorization: Bearer <token>" value (case-insensitive
// scheme), or "" when absent.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

// ── local-user management (admin only) ───────────────────────────────────────

type createUserBody struct {
	Username           string  `json:"username"`
	Password           string  `json:"password"`
	FullName           *string `json:"full_name"`
	Role               *string `json:"role"` // admin|operator|viewer (default viewer)
	IsActive           *bool   `json:"is_active"`
	MustChangePassword *bool   `json:"must_change_password"`
}

type updateUserBody struct {
	FullName           *string `json:"full_name"`
	Role               *string `json:"role"`
	IsActive           *bool   `json:"is_active"`
	Password           *string `json:"password"` // set → re-hash
	MustChangePassword *bool   `json:"must_change_password"`
}

// validRole reports whether role is one of the three local roles.
func validRole(role string) bool {
	switch role {
	case "admin", "operator", "viewer":
		return true
	default:
		return false
	}
}

func (h *authHandler) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.d.DB.ListLocalUsers(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to list local users"))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": users, "total": len(users)})
}

func (h *authHandler) getUser(w http.ResponseWriter, r *http.Request) {
	user, err := h.d.DB.GetLocalUserByID(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.NotFound("local user not found"))
		return
	}
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to load local user"))
		return
	}
	httpx.JSON(w, http.StatusOK, user)
}

func (h *authHandler) createUser(w http.ResponseWriter, r *http.Request) {
	var body createUserBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if strings.TrimSpace(body.Username) == "" {
		kerr.Write(w, kerr.BadRequest("username is required"))
		return
	}
	if body.Password == "" {
		kerr.Write(w, kerr.BadRequest("password is required"))
		return
	}
	role := "viewer"
	if body.Role != nil {
		role = *body.Role
	}
	if !validRole(role) {
		kerr.Write(w, kerr.BadRequest("role must be admin, operator, or viewer"))
		return
	}

	// Reject a duplicate username up front (the UNIQUE index would also catch it,
	// but a clean 409 is friendlier than a generic insert error).
	if _, err := h.d.DB.GetLocalUserByName(r.Context(), body.Username); err == nil {
		kerr.Write(w, kerr.Conflict("username already exists"))
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.Internal("failed to check username"))
		return
	}

	hash, err := localauth.HashPassword(body.Password)
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to hash password"))
		return
	}

	now := time.Now().UTC()
	user := store.LocalUser{
		ID:                 uuid.NewString(),
		Username:           body.Username,
		FullName:           body.FullName,
		PasswordHash:       hash,
		Role:               role,
		IsActive:           boolOr(body.IsActive, true),
		IsBootstrap:        false,
		MustChangePassword: boolOr(body.MustChangePassword, false),
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	if err := h.d.DB.CreateLocalUser(r.Context(), user); err != nil {
		kerr.Write(w, kerr.Internal("failed to create local user"))
		return
	}
	h.audit(r, actorFrom(r), "local_user.create", user.ID)
	httpx.JSON(w, http.StatusCreated, user)
}

func (h *authHandler) updateUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	user, err := h.d.DB.GetLocalUserByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.NotFound("local user not found"))
		return
	}
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to load local user"))
		return
	}

	var body updateUserBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if body.Role != nil {
		if !validRole(*body.Role) {
			kerr.Write(w, kerr.BadRequest("role must be admin, operator, or viewer"))
			return
		}
		user.Role = *body.Role
	}
	if body.FullName != nil {
		user.FullName = body.FullName
	}
	if body.IsActive != nil {
		// The bootstrap admin must never be deactivated — it is the local root of
		// trust for the appliance.
		if user.IsBootstrap && !*body.IsActive {
			kerr.Write(w, kerr.BadRequest("cannot deactivate the bootstrap admin"))
			return
		}
		user.IsActive = *body.IsActive
	}
	if body.MustChangePassword != nil {
		user.MustChangePassword = *body.MustChangePassword
	}
	if body.Password != nil {
		if *body.Password == "" {
			kerr.Write(w, kerr.BadRequest("password cannot be empty"))
			return
		}
		hash, herr := localauth.HashPassword(*body.Password)
		if herr != nil {
			kerr.Write(w, kerr.Internal("failed to hash password"))
			return
		}
		user.PasswordHash = hash
	}
	user.UpdatedAt = time.Now().UTC()

	if err := h.d.DB.UpdateLocalUser(r.Context(), user); err != nil {
		kerr.Write(w, kerr.Internal("failed to update local user"))
		return
	}
	h.audit(r, actorFrom(r), "local_user.update", user.ID)
	httpx.JSON(w, http.StatusOK, user)
}

func (h *authHandler) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	user, err := h.d.DB.GetLocalUserByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.NotFound("local user not found"))
		return
	}
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to load local user"))
		return
	}
	// The bootstrap admin is the appliance's local root — never removable.
	if user.IsBootstrap {
		kerr.Write(w, kerr.BadRequest("cannot delete the bootstrap admin"))
		return
	}
	if err := h.d.DB.DeleteLocalUser(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			kerr.Write(w, kerr.NotFound("local user not found"))
			return
		}
		kerr.Write(w, kerr.Internal("failed to delete local user"))
		return
	}
	h.audit(r, actorFrom(r), "local_user.delete", id)
	w.WriteHeader(http.StatusNoContent)
}

// ── shared helpers ───────────────────────────────────────────────────────────

// audit appends a best-effort audit_log row for a write (never fails the request).
func (h *authHandler) audit(r *http.Request, actor *string, action, target string) {
	kind := "system"
	if c, ok := localauth.CallerFrom(r.Context()); ok {
		kind = c.Kind
	}
	_ = h.d.DB.AppendAudit(r.Context(), store.AuditEntry{
		Actor:     actor,
		ActorKind: kind,
		Action:    action,
		Target:    &target,
	})
}

// actorFrom returns the authenticated caller's subject (user/node id) for audit
// attribution, or nil when the request did not pass through Authenticate.
func actorFrom(r *http.Request) *string {
	if c, ok := localauth.CallerFrom(r.Context()); ok && c.Subject != "" {
		s := c.Subject
		return &s
	}
	return nil
}
