package estate

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"

	"github.com/neubit/nvr/internal/mediatoken"
)

// MountPublic wires the node's PUBLIC media-plane routes under an
// already-versioned parent (/api/v1/nvr) — NOT behind localauth.Authenticate.
// Currently just the MediaMTX media-auth hot path:
//
//	GET  /media/verify → Traefik ForwardAuth (central mode): token in ?token= /
//	                     Authorization / X-Forwarded-Uri → 200 / 401
//	POST /media/verify → MediaMTX native HTTP auth (standalone appliance mode):
//	                     token in the JSON body's `token` / `query` field → 200 / 401
//
// It authorises off the media token alone (no session/bearer, no DB), so it must
// sit OUTSIDE the estate auth middleware — the Authenticator rejects media tokens
// on purpose. Mount this as a sibling of estate.Mount in main.go's sqlite branch.
//
// The GET path serves the Traefik ForwardAuth used by the CENTRAL gateway. The
// POST path serves MediaMTX's own `authMethod: http` (`authHTTPAddress`), which
// the STANDALONE recorder appliance points here so live/playback media is gated
// by THIS node with no gateway in front (deploy/recorder-appliance).
func MountPublic(r chi.Router, _ *Deps) {
	r.Get("/media/verify", mediaVerify)
	r.Post("/media/verify", mediaVerify)
}

// mediaVerify validates the media token and returns 200 when valid. The token
// comes from ?token=<t> (the URL the browser plays) or, when Traefik ForwardAuth
// strips the query on the auth subrequest, from the forwarded original request —
// an Authorization: Bearer header or the X-Forwarded-Uri header's query. Mirrors
// vision's _token_from_headers. Single HMAC verify, no DB on the hot path.
func mediaVerify(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	if tok == "" {
		tok = tokenFromHeaders(r)
	}
	// Standalone appliance: MediaMTX native HTTP auth (POST) carries the client's
	// query + token in a JSON body rather than the URL/headers.
	if tok == "" && r.Method == http.MethodPost {
		tok = tokenFromMediaMTXBody(r)
	}
	if tok == "" {
		kerr.Write(w, kerr.Unauthorized("missing media token"))
		return
	}
	if _, err := mediatoken.Verify(tok); err != nil {
		kerr.Write(w, kerr.Unauthorized("invalid media token"))
		return
	}
	w.WriteHeader(http.StatusOK)
}

// tokenFromHeaders extracts a media token from the headers Traefik ForwardAuth
// may forward when the query is not passed on the auth subrequest: an
// Authorization: Bearer header, or the X-Forwarded-Uri header's ?token=.
func tokenFromHeaders(r *http.Request) string {
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	if fwd := r.Header.Get("X-Forwarded-Uri"); strings.Contains(fwd, "token=") {
		if u, err := url.Parse(fwd); err == nil {
			if t := u.Query().Get("token"); t != "" {
				return t
			}
		}
	}
	return ""
}

// tokenFromMediaMTXBody extracts the media token from MediaMTX's native HTTP-auth
// request. MediaMTX (authMethod: http) POSTs a JSON body describing the access
// attempt; the browser's HLS/WHEP/playback URL query (?token=<t>) arrives in the
// `query` field, and MediaMTX also lifts a `token` query param into a top-level
// `token` field. We read either. Used by the standalone recorder appliance, where
// MediaMTX — not a Traefik gateway — calls this endpoint.
func tokenFromMediaMTXBody(r *http.Request) string {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil || len(body) == 0 {
		return ""
	}
	var req struct {
		Token string `json:"token"`
		Query string `json:"query"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}
	if req.Token != "" {
		return req.Token
	}
	if req.Query != "" {
		if q, err := url.ParseQuery(strings.TrimPrefix(req.Query, "?")); err == nil {
			if t := q.Get("token"); t != "" {
				return t
			}
		}
	}
	return ""
}
