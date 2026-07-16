package identity

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/sqlitestore"
)

func newDB(t *testing.T) *sqlitestore.DB {
	t.Helper()
	db, err := sqlitestore.Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func TestBootstrapCreatesIdentityAndAdmin(t *testing.T) {
	db := newDB(t)
	ctx := context.Background()

	res, err := Bootstrap(ctx, db, Config{AdminUser: "admin", AdminPassword: "dev"})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if res.AlreadyBootstrapped {
		t.Fatalf("first boot should not report AlreadyBootstrapped")
	}
	if res.Identity.ID == "" || res.Identity.EnrollState != "standalone" {
		t.Fatalf("bad identity: %+v", res.Identity)
	}
	if res.GeneratedNodeSecret == "" {
		t.Fatalf("expected a generated node secret (none supplied)")
	}
	if res.GeneratedAdminPassword != "" {
		t.Fatalf("admin password was supplied; none should be generated")
	}

	// The bootstrap admin can log in with the supplied password.
	svc := localauth.NewService(db, localauth.Config{})
	if _, u, err := svc.Login(ctx, "admin", "dev"); err != nil || u.Role != "admin" || !u.IsBootstrap {
		t.Fatalf("bootstrap admin login failed: u=%+v err=%v", u, err)
	}

	// Second call is a no-op.
	res2, err := Bootstrap(ctx, db, Config{AdminUser: "admin", AdminPassword: "dev"})
	if err != nil {
		t.Fatalf("bootstrap #2: %v", err)
	}
	if !res2.AlreadyBootstrapped || res2.Identity.ID != res.Identity.ID {
		t.Fatalf("second bootstrap should be a no-op, got %+v", res2)
	}
	n, _ := db.CountLocalUsers(ctx)
	if n != 1 {
		t.Fatalf("expected exactly one local user, got %d", n)
	}
}

func TestBootstrapGeneratesAdminPasswordWhenAbsent(t *testing.T) {
	db := newDB(t)
	ctx := context.Background()

	res, err := Bootstrap(ctx, db, Config{NodeSecret: "fixed-secret"})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if res.GeneratedNodeSecret != "" {
		t.Fatalf("node secret was supplied; none should be generated")
	}
	if res.GeneratedAdminPassword == "" {
		t.Fatalf("expected a generated admin password")
	}
	// The generated password logs in, and the account is flagged must-change.
	svc := localauth.NewService(db, localauth.Config{})
	if _, u, err := svc.Login(ctx, "admin", res.GeneratedAdminPassword); err != nil {
		t.Fatalf("generated-password login failed: %v", err)
	} else if !u.MustChangePassword {
		t.Fatalf("generated-password account should require a change")
	}
}
