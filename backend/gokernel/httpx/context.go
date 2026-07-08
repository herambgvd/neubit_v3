// Package httpx wires a chi router with the standard neubit_v3 middleware stack
// (request-id, recover, CORS, JWT auth, tenant scope) + a health handler. It is
// the Go analogue of the FastAPI app assembly the Python services build in
// app/main.py (CORSMiddleware + kernel auth deps + /health).
package httpx

import (
	"context"
	"net/http"

	"github.com/neubit/gokernel/auth"
	kerr "github.com/neubit/gokernel/errors"
)

type ctxKey int

const (
	principalKey ctxKey = iota
	scopeKey
)

// PrincipalFrom returns the authenticated caller stored by RequireAuth. The
// bool is false if the request did not pass through RequireAuth.
func PrincipalFrom(ctx context.Context) (*auth.Principal, bool) {
	p, ok := ctx.Value(principalKey).(*auth.Principal)
	return p, ok
}

// ScopeFrom returns the caller's tenancy scope stored by RequireAuth.
func ScopeFrom(ctx context.Context) (auth.Scope, bool) {
	s, ok := ctx.Value(scopeKey).(auth.Scope)
	return s, ok
}

// MustPrincipal returns the caller or writes a 401 and returns false. Use at the
// top of a handler that RequireAuth already guards (defensive).
func MustPrincipal(w http.ResponseWriter, r *http.Request) (*auth.Principal, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		kerr.Write(w, kerr.Unauthorized("missing bearer token"))
		return nil, false
	}
	return p, true
}
