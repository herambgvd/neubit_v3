package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const testSecret = "dev-jwt-secret-change-me-to-a-long-random-string-32b"

// mintCoreLikeToken reproduces the Python core's create_access_token() claim set
// (backend/core/app/auth/security.py): HS256, sub/type/tenant_id/is_superadmin/
// permissions/iat/exp. Verifying it here proves cross-language parity.
func mintCoreLikeToken(t *testing.T, sub string, tenantID *string, super bool, perms []string) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":           sub,
		"type":          "access",
		"is_superadmin": super,
		"permissions":   perms,
		"iat":           time.Now().Unix(),
		"exp":           time.Now().Add(time.Hour).Unix(),
	}
	if tenantID != nil {
		claims["tenant_id"] = *tenantID
	} else {
		claims["tenant_id"] = nil
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	return signed
}

func TestVerify_TenantAdmin(t *testing.T) {
	v := NewVerifier(testSecret)
	sub := uuid.NewString()
	tid := uuid.NewString()
	token := mintCoreLikeToken(t, sub, &tid, false, []string{"vms.camera.read", "vms.camera.manage"})

	p, err := v.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if p.UserID.String() != sub {
		t.Errorf("sub = %s, want %s", p.UserID, sub)
	}
	if p.TenantID == nil || p.TenantID.String() != tid {
		t.Errorf("tenant_id = %v, want %s", p.TenantID, tid)
	}
	if p.IsSuperadmin {
		t.Error("is_superadmin should be false")
	}
	if !p.Grants("vms.camera.read") {
		t.Error("should grant vms.camera.read")
	}
	if p.Grants("vms.nvr.manage") {
		t.Error("should NOT grant vms.nvr.manage")
	}
}

func TestVerify_Superadmin(t *testing.T) {
	v := NewVerifier(testSecret)
	token := mintCoreLikeToken(t, uuid.NewString(), nil, true, []string{"*"})
	p, err := v.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !p.IsSuperadmin {
		t.Error("expected superadmin")
	}
	if p.TenantID != nil {
		t.Errorf("superadmin tenant_id should be nil, got %v", p.TenantID)
	}
	if !p.Grants("anything.at.all") {
		t.Error("superadmin should grant any permission")
	}
}

func TestVerify_WildcardGrant(t *testing.T) {
	v := NewVerifier(testSecret)
	tid := uuid.NewString()
	token := mintCoreLikeToken(t, uuid.NewString(), &tid, false, []string{"*"})
	p, _ := v.Verify(token)
	if !p.Grants("vms.export") {
		t.Error("wildcard permission should grant everything")
	}
}

func TestVerify_WrongSecret(t *testing.T) {
	token := mintCoreLikeToken(t, uuid.NewString(), nil, true, nil)
	v := NewVerifier("a-different-secret")
	if _, err := v.Verify(token); err == nil {
		t.Fatal("verify with wrong secret must fail")
	}
}

func TestVerify_NotAccessToken(t *testing.T) {
	claims := jwt.MapClaims{
		"sub":  uuid.NewString(),
		"type": "refresh",
		"exp":  time.Now().Add(time.Hour).Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, _ := tok.SignedString([]byte(testSecret))
	v := NewVerifier(testSecret)
	if _, err := v.Verify(signed); err == nil {
		t.Fatal("non-access token must be rejected")
	}
}

func TestVerify_Expired(t *testing.T) {
	claims := jwt.MapClaims{
		"sub":  uuid.NewString(),
		"type": "access",
		"exp":  time.Now().Add(-time.Hour).Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, _ := tok.SignedString([]byte(testSecret))
	v := NewVerifier(testSecret)
	if _, err := v.Verify(signed); err == nil {
		t.Fatal("expired token must be rejected")
	}
}
