package localauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/neubit/gokernel/auth"
	"github.com/neubit/nvr/internal/sqlitestore"
)

const testJWTSecret = "dev-jwt-secret-change-me-to-a-long-random-string-32b"

// probe is the terminal handler: it records the resolved Caller and returns 200,
// so a test can assert both the status and the Kind that authenticated.
func probe(seen *Caller) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := CallerFrom(r.Context())
		*seen = c
		w.WriteHeader(http.StatusOK)
	})
}

func mintAccessToken(t *testing.T, perms []string, super bool) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":           uuid.NewString(),
		"type":          "access",
		"is_superadmin": super,
		"permissions":   perms,
		"exp":           time.Now().Add(time.Hour).Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("mint access token: %v", err)
	}
	return signed
}

func mintMediaToken(t *testing.T) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub_type":  "media",
		"tenant_id": uuid.NewString(),
		"camera_id": uuid.NewString(),
		"exp":       time.Now().Add(time.Hour).Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("mint media token: %v", err)
	}
	return signed
}

func newAuthenticator(t *testing.T, db *sqlitestore.DB) *Authenticator {
	t.Helper()
	svc := NewService(db, Config{})
	return NewAuthenticator(svc, auth.NewVerifier(testJWTSecret), db)
}

func TestAuthenticate_LocalSession(t *testing.T) {
	db := newTestDB(t)
	seedAdmin(t, db, "s3cret")
	svc := NewService(db, Config{})
	token, _, err := svc.Login(t.Context(), "admin", "s3cret")
	if err != nil {
		t.Fatalf("login: %v", err)
	}

	auth := NewAuthenticator(svc, mustVerifier(), db)
	var seen Caller
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/cameras", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	auth.Authenticate(probe(&seen)).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if seen.Kind != "local" || seen.Role != "admin" {
		t.Fatalf("caller = %+v, want Kind=local Role=admin", seen)
	}
}

func TestAuthenticate_CentralJWT(t *testing.T) {
	db := newTestDB(t)
	auth := newAuthenticator(t, db)

	var seen Caller
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/cameras", nil)
	req.Header.Set("Authorization", "Bearer "+mintAccessToken(t, []string{"vms.camera.read"}, false))
	auth.Authenticate(probe(&seen)).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if seen.Kind != "central" {
		t.Fatalf("caller = %+v, want Kind=central", seen)
	}
}

func TestAuthenticate_NoCredentials(t *testing.T) {
	db := newTestDB(t)
	auth := newAuthenticator(t, db)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/cameras", nil)
	auth.Authenticate(probe(new(Caller))).ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

func TestAuthenticate_MediaTokenRejected(t *testing.T) {
	db := newTestDB(t)
	auth := newAuthenticator(t, db)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/cameras", nil)
	req.Header.Set("Authorization", "Bearer "+mintMediaToken(t))
	auth.Authenticate(probe(new(Caller))).ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("media token status = %d, want 401", rr.Code)
	}
}

func TestRequireLocalRole(t *testing.T) {
	// operator caller should pass an operator gate but fail an admin gate.
	c := Caller{Kind: "local", Role: "operator"}
	if !callerGrants(c, "vms.recording.control") {
		t.Fatalf("operator should grant a control perm")
	}
	if callerGrants(Caller{Kind: "local", Role: "viewer"}, "vms.recording.control") {
		t.Fatalf("viewer should NOT grant a control perm")
	}
	if !callerGrants(Caller{Kind: "local", Role: "viewer"}, "vms.camera.read") {
		t.Fatalf("viewer should grant a read perm")
	}
}

func mustVerifier() *auth.Verifier { return auth.NewVerifier(testJWTSecret) }
