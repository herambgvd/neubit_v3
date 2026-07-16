package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/neubit/nvr/internal/store"
)

func TestNodeIdentityRoundTrip(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Not-found before bootstrap.
	if _, err := db.GetNodeIdentity(ctx); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	cred := "enc:abc"
	in := store.NodeIdentity{
		ID:             "node-1",
		Name:           "rack-a",
		EnrollState:    "standalone",
		NodeCredential: &cred,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := db.UpsertNodeIdentity(ctx, in); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := db.GetNodeIdentity(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ID != "node-1" || got.EnrollState != "standalone" || !got.CreatedAt.Equal(now) {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	if got.NodeCredential == nil || *got.NodeCredential != "enc:abc" {
		t.Fatalf("credential not round-tripped: %+v", got.NodeCredential)
	}
	if got.TenantID != nil || got.EnrolledAt != nil {
		t.Fatalf("nullable columns should be nil: %+v", got)
	}

	// Upsert again (state change) updates in place, no duplicate row.
	in.EnrollState = "enrolled"
	in.UpdatedAt = now.Add(time.Minute)
	if err := db.UpsertNodeIdentity(ctx, in); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got2, _ := db.GetNodeIdentity(ctx)
	if got2.EnrollState != "enrolled" {
		t.Fatalf("update lost: %+v", got2)
	}
	var n int
	if err := db.ro.QueryRowContext(ctx, "SELECT COUNT(*) FROM node_identity").Scan(&n); err != nil || n != 1 {
		t.Fatalf("expected single identity row, got n=%d err=%v", n, err)
	}
}
