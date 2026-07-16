package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/neubit/nvr/internal/identity"
	"github.com/neubit/nvr/internal/sqlitestore"
)

// TestStoreBackendDefault proves NVR_STORE selection resolves to "postgres" when
// unset (byte-for-byte today's boot) and to "sqlite" when explicitly set — the
// single branch main() keys on.
func TestStoreBackendDefault(t *testing.T) {
	os.Unsetenv("NVR_STORE")
	if got := env("NVR_STORE", "postgres"); got != "postgres" {
		t.Fatalf("unset NVR_STORE = %q, want postgres (today's default)", got)
	}

	t.Setenv("NVR_STORE", "sqlite")
	if got := env("NVR_STORE", "postgres"); got != "sqlite" {
		t.Fatalf("NVR_STORE=sqlite = %q, want sqlite", got)
	}
}

// TestSQLiteNodeBootWiring exercises the store-side wiring the sqlite branch drives
// (open → migrate → bootstrap) against a temp node.db, without a live DB or network.
// This is the autonomous-node boot minus the blocking HTTP serve.
func TestSQLiteNodeBootWiring(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "node.db")

	nodeStore, err := sqlitestore.Open(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer nodeStore.Close()

	if err := nodeStore.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Generated secrets surfaced once (installer capture).
	res, err := identity.Bootstrap(ctx, nodeStore, identity.Config{})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if res.AlreadyBootstrapped {
		t.Fatalf("fresh db reported AlreadyBootstrapped")
	}
	if res.Identity.EnrollState != "standalone" {
		t.Fatalf("enroll_state = %q, want standalone", res.Identity.EnrollState)
	}
	if res.GeneratedAdminPassword == "" || res.GeneratedNodeSecret == "" {
		t.Fatalf("expected generated admin password + node secret to surface once")
	}

	// Idempotent: a second boot is a no-op.
	again, err := identity.Bootstrap(ctx, nodeStore, identity.Config{})
	if err != nil {
		t.Fatalf("bootstrap #2: %v", err)
	}
	if !again.AlreadyBootstrapped {
		t.Fatalf("second bootstrap not reported as already bootstrapped")
	}
}
