package mediatoken

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestMintVerifyRoundTrip(t *testing.T) {
	t.Setenv("VE_JWT_SECRET", "test-secret-32-bytes-long-aaaaaaaa")

	token, exp, err := Mint("cam-1", "tenant-a", "sess-1", "live", time.Minute)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if token == "" {
		t.Fatal("empty token")
	}
	if time.Until(exp) <= 0 {
		t.Fatalf("exp not in future: %v", exp)
	}

	claims, err := Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if claims.SubType != subTypeMedia {
		t.Errorf("sub_type = %q, want %q", claims.SubType, subTypeMedia)
	}
	if claims.CameraID != "cam-1" || claims.TenantID != "tenant-a" ||
		claims.SessionID != "sess-1" || claims.Mode != "live" {
		t.Errorf("claims round-trip mismatch: %+v", claims)
	}
}

func TestMintDefaults(t *testing.T) {
	t.Setenv("VE_JWT_SECRET", "test-secret-32-bytes-long-aaaaaaaa")

	// Empty mode/tenant + ttl<=0 → defaults ("live"/"platform"/300s).
	token, exp, err := Mint("cam-2", "", "sess-2", "", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	claims, err := Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if claims.Mode != "live" {
		t.Errorf("mode = %q, want live", claims.Mode)
	}
	if claims.TenantID != "platform" {
		t.Errorf("tenant_id = %q, want platform", claims.TenantID)
	}
	if d := time.Until(exp); d < 4*time.Minute || d > 6*time.Minute {
		t.Errorf("default ttl out of range: %v", d)
	}
}

func TestVerifyWrongKeyFails(t *testing.T) {
	t.Setenv("VE_JWT_SECRET", "secret-one-32-bytes-long-aaaaaaaa")
	token, _, err := Mint("cam-1", "tenant-a", "sess-1", "live", time.Minute)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	// Rotate the anchor secret → the old token must no longer verify.
	t.Setenv("VE_JWT_SECRET", "secret-two-32-bytes-long-bbbbbbbb")
	if _, err := Verify(token); err == nil {
		t.Fatal("expected wrong-key verify to fail")
	}
}

func TestVerifyExpiredFails(t *testing.T) {
	t.Setenv("VE_JWT_SECRET", "test-secret-32-bytes-long-aaaaaaaa")
	// Hand-mint a token whose exp is already in the past (Mint clamps ttl<=0 to the
	// default, so build it directly to exercise the expiry path).
	claims := Claims{
		SubType:   subTypeMedia,
		TenantID:  "tenant-a",
		CameraID:  "cam-1",
		SessionID: "sess-1",
		Mode:      "live",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Minute)),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Minute)),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret())
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := Verify(token); err == nil {
		t.Fatal("expected expired verify to fail")
	}
}

func TestVerifyEmptyFails(t *testing.T) {
	if _, err := Verify(""); err == nil {
		t.Fatal("expected empty token to fail")
	}
}

func TestVerifyRejectsNonMediaSubType(t *testing.T) {
	t.Setenv("VE_JWT_SECRET", "test-secret-32-bytes-long-aaaaaaaa")
	// Hand-mint a token with the SAME key but sub_type "access" → must be rejected.
	claims := Claims{
		SubType:   "access",
		TenantID:  "tenant-a",
		CameraID:  "cam-1",
		SessionID: "sess-1",
		Mode:      "live",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret())
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := Verify(token); err == nil {
		t.Fatal("expected non-media sub_type to be rejected")
	}
}
