package httpx

import (
	"context"
	"log"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/neubit/gokernel/auth"
	"github.com/neubit/gokernel/config"
	kerr "github.com/neubit/gokernel/errors"
)

// RequestID injects/propagates an X-Request-Id (chi's, aliased for a stable name).
func RequestID(next http.Handler) http.Handler { return middleware.RequestID(next) }

// Recover converts a panic into the uniform 500 error envelope instead of a
// dropped connection (the Go analogue of the Python catch-all handler).
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic on %s %s: %v", r.Method, r.URL.Path, rec)
				kerr.Write(w, kerr.Internal("An unexpected error occurred"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// CORS mirrors the Python services' CORSMiddleware: echo an allowed origin
// (explicit list OR the origin regex), allow credentials, all methods/headers.
func CORS(s *config.Settings) func(http.Handler) http.Handler {
	var re *regexp.Regexp
	if s.CORSOriginRegex != "" {
		re, _ = regexp.Compile("^" + s.CORSOriginRegex + "$")
	}
	allowed := func(origin string) bool {
		if origin == "" {
			return false
		}
		for _, o := range s.CORSOrigins {
			if o == origin {
				return true
			}
		}
		return re != nil && re.MatchString(origin)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if allowed(origin) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Vary", "Origin")
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Set("Access-Control-Allow-Methods", "*")
				h.Set("Access-Control-Allow-Headers", "*")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireAuth verifies the Bearer access token, stores the Principal + Scope on
// the request context, and 401s on failure — the Go analogue of the Python
// get_principal dependency. Apply it to any router group that needs auth.
func RequireAuth(v *auth.Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearer(r)
			if token == "" {
				kerr.Write(w, kerr.Unauthorized("missing bearer token"))
				return
			}
			principal, err := v.Verify(token)
			if err != nil {
				kerr.Write(w, err)
				return
			}
			ctx := context.WithValue(r.Context(), principalKey, principal)
			ctx = context.WithValue(ctx, scopeKey, auth.ScopeOf(principal))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequirePermission gates a route: the caller (already authenticated by
// RequireAuth) must be super-admin, hold "*", or grant ALL listed permissions —
// the Go analogue of the Python require_permission() dependency factory.
func RequirePermission(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := PrincipalFrom(r.Context())
			if !ok {
				kerr.Write(w, kerr.Unauthorized("missing bearer token"))
				return
			}
			var missing []string
			for _, perm := range perms {
				if !p.Grants(perm) {
					missing = append(missing, perm)
				}
			}
			if len(missing) > 0 {
				kerr.Write(w, kerr.Forbidden("missing permission(s): "+strings.Join(missing, ", ")))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return h[len(prefix):]
	}
	return ""
}

// ensure uuid import is used (Principal ids parse via uuid elsewhere; keep the
// dependency graph explicit for tooling).
var _ = uuid.Nil
