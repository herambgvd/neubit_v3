package estate

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"

	"github.com/neubit/nvr/internal/mediatoken"
)

// MountPublic wires the node's PUBLIC media-plane routes under an
// already-versioned parent (/api/v1/nvr) — NOT behind localauth.Authenticate.
// Currently just the MediaMTX ForwardAuth hot path:
//
//	GET /media/verify → validate a media token → 200 / 401 / 403
//
// It authorises off the media token alone (no session/bearer, no DB), so it must
// sit OUTSIDE the estate auth middleware — the Authenticator rejects media tokens
// on purpose. Mount this as a sibling of estate.Mount in main.go's sqlite branch.
func MountPublic(r chi.Router, _ *Deps) {
	r.Get("/media/verify", mediaVerify)
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
