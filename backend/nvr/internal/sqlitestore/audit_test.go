package sqlitestore

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/neubit/nvr/internal/store"
)

func TestAppendAndListAudit(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	actor := "user-1"
	target := "cam-1"
	if err := db.AppendAudit(ctx, store.AuditEntry{
		Actor: &actor, ActorKind: "local", Action: "camera.create", Target: &target,
		Detail: json.RawMessage(`{"name":"Ch 1"}`),
	}); err != nil {
		t.Fatalf("append #1: %v", err)
	}
	// A minimal row (no actor/target/detail) exercises the defaults + NULL scan.
	if err := db.AppendAudit(ctx, store.AuditEntry{Action: "camera.delete"}); err != nil {
		t.Fatalf("append #2: %v", err)
	}

	got, err := db.ListAudit(ctx, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 rows, got %d", len(got))
	}
	// Newest first — the delete (row 2) precedes the create (row 1).
	if got[0].Action != "camera.delete" || got[1].Action != "camera.create" {
		t.Fatalf("order wrong: %q then %q", got[0].Action, got[1].Action)
	}
	if got[0].Actor != nil {
		t.Fatalf("expected nil actor on minimal row, got %v", *got[0].Actor)
	}
	if got[0].ActorKind != "system" {
		t.Fatalf("actor_kind default = %q, want system", got[0].ActorKind)
	}
	if string(got[0].Detail) != "{}" {
		t.Fatalf("detail default = %q, want {}", string(got[0].Detail))
	}
	if got[1].Actor == nil || *got[1].Actor != "user-1" || got[1].Target == nil || *got[1].Target != "cam-1" {
		t.Fatalf("create row fields lost: %+v", got[1])
	}
	if got[0].TS.IsZero() {
		t.Fatalf("ts default-now not applied")
	}
}
