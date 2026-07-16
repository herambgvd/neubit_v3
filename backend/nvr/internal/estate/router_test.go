package estate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/sqlitestore"
	"github.com/neubit/nvr/internal/store"
)

// newNode boots a migrated SQLite estate with a seeded admin + node identity, and
// returns the store, a login service, and a router with the estate API mounted
// exactly as main.go wires it in sqlite mode.
func newNode(t *testing.T) (*sqlitestore.DB, *localauth.Service, chi.Router) {
	t.Helper()
	db, err := sqlitestore.Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	now := time.Now().UTC()
	hash, err := localauth.HashPassword("s3cret")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := db.CreateLocalUser(ctx, store.LocalUser{
		ID: "u-admin", Username: "admin", PasswordHash: hash, Role: "admin",
		IsActive: true, IsBootstrap: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if err := db.UpsertNodeIdentity(ctx, store.NodeIdentity{
		ID: "node-1", Name: "rack-a", EnrollState: "standalone", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed identity: %v", err)
	}

	svc := localauth.NewService(db, localauth.Config{})
	r := chi.NewRouter()
	r.Route("/api/v1/nvr", func(api chi.Router) {
		Mount(api, &Deps{DB: db, Auth: svc, NodeName: "rack-a"})
	})
	return db, svc, r
}

func loginToken(t *testing.T, svc *localauth.Service) string {
	t.Helper()
	token, _, err := svc.Login(context.Background(), "admin", "s3cret")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	return token
}

func TestEstateNode_LocalSession(t *testing.T) {
	_, svc, r := newNode(t)
	token := loginToken(t, svc)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/node", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["id"] != "node-1" || body["enroll_state"] != "standalone" {
		t.Fatalf("node body wrong: %+v", body)
	}
}

func TestEstateNode_NoCredentials(t *testing.T) {
	_, _, r := newNode(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/node", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

func TestEstateHealth(t *testing.T) {
	_, svc, r := newNode(t)
	token := loginToken(t, svc)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/health", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["store"] != "sqlite" || body["db_ok"] != true {
		t.Fatalf("health body wrong: %+v", body)
	}
	// storage + raid keys are always present (graceful even without hardware RAID).
	if _, ok := body["storage"]; !ok {
		t.Fatalf("missing storage in health: %+v", body)
	}
	if _, ok := body["raid"]; !ok {
		t.Fatalf("missing raid in health: %+v", body)
	}
}
