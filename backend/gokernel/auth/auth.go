// Package auth verifies the core-minted access token LOCALLY (no round-trip to
// core), mirroring the Python kernel (backend/kernel/kernel/auth.py) exactly:
//
//   - algorithm: HS256, shared secret VE_JWT_SECRET
//   - required claim: type == "access"
//   - claims consumed: sub, tenant_id, is_superadmin, permissions[]
//
// A token minted by the Python core's create_access_token() therefore verifies
// here byte-for-byte, and a Go-verified Principal has the same authorization
// semantics (grants / super-admin / wildcard) as the Python Principal.
package auth

import (
	stderrors "errors"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	kerr "github.com/neubit/gokernel/errors"
)

// Wildcard permission — a Principal holding "*" grants everything (matches the
// Python kernel's WILDCARD and core's super-admin ["*"] token claim).
const Wildcard = "*"

// Principal is the authenticated caller, decoded from the access token.
type Principal struct {
	UserID       uuid.UUID
	TenantID     *uuid.UUID // nil for platform super-admins
	IsSuperadmin bool
	Permissions  []string
}

// Grants reports whether the caller holds a permission (super-admin or "*" grant
// everything). Same rule as the Python Principal.grants().
func (p *Principal) Grants(permission string) bool {
	if p.IsSuperadmin {
		return true
	}
	for _, perm := range p.Permissions {
		if perm == Wildcard || perm == permission {
			return true
		}
	}
	return false
}

// Scope is the caller's tenancy scope, resolved from the Principal.
type Scope struct {
	TenantID     *uuid.UUID
	IsSuperadmin bool
}

// IsPlatform is true for a super-admin: no tenant filter, no ownership checks.
func (s Scope) IsPlatform() bool { return s.IsSuperadmin }

// ScopeOf builds a Scope from a Principal.
func ScopeOf(p *Principal) Scope {
	return Scope{TenantID: p.TenantID, IsSuperadmin: p.IsSuperadmin}
}

// claims is the raw JWT payload shape the Python core mints.
type claims struct {
	Type         string   `json:"type"`
	TenantID     *string  `json:"tenant_id"`
	IsSuperadmin bool     `json:"is_superadmin"`
	Permissions  []string `json:"permissions"`
	jwt.RegisteredClaims
}

// Verifier decodes + validates access tokens with the shared HS256 secret.
type Verifier struct {
	secret []byte
}

// NewVerifier builds a Verifier from the shared JWT secret (VE_JWT_SECRET).
func NewVerifier(secret string) *Verifier {
	return &Verifier{secret: []byte(secret)}
}

// Verify decodes + verifies an access token → Principal. Returns an
// UNAUTHORIZED APIError on any signature/expiry/type/subject problem — the same
// failure surface as the Python verify_token().
func (v *Verifier) Verify(token string) (*Principal, error) {
	c := &claims{}
	parsed, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, stderrors.New("unexpected signing method")
		}
		return v.secret, nil
	})
	if err != nil || !parsed.Valid {
		return nil, kerr.Unauthorized("invalid or expired token")
	}
	if c.Type != "access" {
		return nil, kerr.Unauthorized("not an access token")
	}
	if c.Subject == "" {
		return nil, kerr.Unauthorized("token missing subject")
	}
	uid, err := uuid.Parse(c.Subject)
	if err != nil {
		return nil, kerr.Unauthorized("token subject is not a valid id")
	}
	var tid *uuid.UUID
	if c.TenantID != nil && *c.TenantID != "" {
		parsedTID, err := uuid.Parse(*c.TenantID)
		if err != nil {
			return nil, kerr.Unauthorized("token tenant_id is not a valid id")
		}
		tid = &parsedTID
	}
	perms := c.Permissions
	if perms == nil {
		perms = []string{}
	}
	return &Principal{
		UserID:       uid,
		TenantID:     tid,
		IsSuperadmin: c.IsSuperadmin,
		Permissions:  perms,
	}, nil
}
