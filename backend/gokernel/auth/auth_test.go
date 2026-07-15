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
	return mintWithEntitlements(t, sub, tenantID, super, perms, nil, nil)
}

// mintWithEntitlements adds the features/limits claims the Python core now bakes in
// (backend/core/app/auth/security.py create_access_token), for parity tests.
func mintWithEntitlements(
	t *testing.T, sub string, tenantID *string, super bool,
	perms []string, features map[string]bool, limits map[string]float64,
) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":           sub,
		"type":          "access",
		"is_superadmin": super,
		"permissions":   perms,
		"features":      features,
		"limits":        limits,
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

func TestVerify_Entitlements(t *testing.T) {
	v := NewVerifier(testSecret)
	tid := uuid.NewString()
	token := mintWithEntitlements(
		t, uuid.NewString(), &tid, false,
		[]string{"vms.camera.read"},
		map[string]bool{"vms": true, "access": false},
		map[string]float64{"max_cameras": 100},
	)
	p, err := v.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !p.FeatureEnabled("vms") {
		t.Error("vms module should be enabled")
	}
	if p.FeatureEnabled("access") {
		t.Error("access module should be disabled")
	}
	if p.FeatureEnabled("fire") {
		t.Error("module fire not in features should be false")
	}
	if v, ok := p.Limit("max_cameras"); !ok || v != 100 {
		t.Errorf("max_cameras = %v (ok=%v), want 100", v, ok)
	}
	if _, ok := p.Limit("max_users"); ok {
		t.Error("unset limit max_users should report ok=false")
	}
}

func TestVerify_LicenseState(t *testing.T) {
	v := NewVerifier(testSecret)
	tid := uuid.NewString()

	// A token with no license_state claim defaults to "active", not expired.
	pActive, _ := v.Verify(mintCoreLikeToken(t, uuid.NewString(), &tid, false, nil))
	if pActive.LicenseState != "active" || pActive.LicenseExpired() {
		t.Errorf("missing claim should default active, got %q expired=%v", pActive.LicenseState, pActive.LicenseExpired())
	}

	// An explicit expired license → LicenseExpired() true for a tenant user.
	claims := jwt.MapClaims{
		"sub": uuid.NewString(), "type": "access", "tenant_id": tid,
		"is_superadmin": false, "license_state": "expired",
		"exp": time.Now().Add(time.Hour).Unix(),
	}
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	pExp, _ := v.Verify(tok)
	if !pExp.LicenseExpired() {
		t.Error("expired license_state should report LicenseExpired() true")
	}

	// Grace is allowed (not expired).
	claims["license_state"] = "grace"
	tokG, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	pGrace, _ := v.Verify(tokG)
	if pGrace.LicenseExpired() {
		t.Error("grace license should NOT be treated as expired")
	}
}

func TestVerify_TenantSuspended(t *testing.T) {
	v := NewVerifier(testSecret)
	tid := uuid.NewString()

	// Missing claim → active, not suspended.
	pActive, _ := v.Verify(mintCoreLikeToken(t, uuid.NewString(), &tid, false, nil))
	if pActive.TenantStatus != "active" || pActive.TenantSuspended() {
		t.Errorf("missing tenant_status should default active, got %q", pActive.TenantStatus)
	}

	// Explicit suspended → TenantSuspended() true.
	claims := jwt.MapClaims{
		"sub": uuid.NewString(), "type": "access", "tenant_id": tid,
		"is_superadmin": false, "tenant_status": "suspended",
		"exp": time.Now().Add(time.Hour).Unix(),
	}
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	pSusp, _ := v.Verify(tok)
	if !pSusp.TenantSuspended() {
		t.Error("suspended tenant_status should report TenantSuspended() true")
	}

	// Super-admin token → never suspended even if claim present.
	claims["is_superadmin"] = true
	claims["tenant_id"] = nil
	tokSA, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	pSA, _ := v.Verify(tokSA)
	if pSA.TenantSuspended() {
		t.Error("super-admin must never be treated as suspended")
	}
}

func TestVerify_Entitlements_SuperadminBypass(t *testing.T) {
	v := NewVerifier(testSecret)
	// Super-admin token carries no entitlements; the accessors must still allow all.
	token := mintCoreLikeToken(t, uuid.NewString(), nil, true, []string{"*"})
	p, _ := v.Verify(token)
	if !p.FeatureEnabled("anything") {
		t.Error("super-admin should have every module enabled")
	}
	if _, ok := p.Limit("max_cameras"); ok {
		t.Error("super-admin should be unlimited (ok=false)")
	}
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
