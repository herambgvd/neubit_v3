package localauth

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/neubit/nvr/internal/sqlitestore"
	"github.com/neubit/nvr/internal/store"
)

func newTestDB(t *testing.T) *sqlitestore.DB {
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

func seedAdmin(t *testing.T, db *sqlitestore.DB, password string) store.LocalUser {
	t.Helper()
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	now := time.Now().UTC()
	u := store.LocalUser{
		ID: "u-admin", Username: "admin", PasswordHash: hash, Role: "admin",
		IsActive: true, IsBootstrap: true, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.CreateLocalUser(context.Background(), u); err != nil {
		t.Fatalf("create admin: %v", err)
	}
	return u
}

func TestLoginAndResolveSession(t *testing.T) {
	db := newTestDB(t)
	seedAdmin(t, db, "s3cret")
	svc := NewService(db, Config{})
	ctx := context.Background()

	token, user, err := svc.Login(ctx, "admin", "s3cret")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if token == "" || user.ID != "u-admin" {
		t.Fatalf("bad login result: token=%q user=%+v", token, user)
	}

	got, err := svc.ResolveSession(ctx, token)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.ID != "u-admin" || got.Role != "admin" {
		t.Fatalf("resolve mismatch: %+v", got)
	}

	// last_login_at stamped, failure count reset.
	reloaded, _ := db.GetLocalUserByName(ctx, "admin")
	if reloaded.LastLoginAt == nil {
		t.Fatalf("last_login_at not stamped")
	}
}

func TestWrongPasswordAndLockout(t *testing.T) {
	db := newTestDB(t)
	seedAdmin(t, db, "s3cret")
	svc := NewService(db, Config{MaxFailed: 3})
	ctx := context.Background()

	// Two wrong attempts → invalid, failure count climbs, not yet locked.
	for i := 0; i < 2; i++ {
		if _, _, err := svc.Login(ctx, "admin", "nope"); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("attempt %d: want ErrInvalidCredentials, got %v", i, err)
		}
	}
	u, _ := db.GetLocalUserByName(ctx, "admin")
	if u.FailedLoginCount != 2 {
		t.Fatalf("failed_login_count = %d, want 2", u.FailedLoginCount)
	}

	// Third wrong attempt hits MaxFailed → locks.
	if _, _, err := svc.Login(ctx, "admin", "nope"); !errors.Is(err, ErrLocked) {
		t.Fatalf("3rd attempt: want ErrLocked, got %v", err)
	}
	locked, _ := db.GetLocalUserByName(ctx, "admin")
	if locked.LockedUntil == nil || !locked.LockedUntil.After(time.Now().UTC()) {
		t.Fatalf("expected locked_until in the future, got %+v", locked.LockedUntil)
	}

	// Even the correct password is refused while locked.
	if _, _, err := svc.Login(ctx, "admin", "s3cret"); !errors.Is(err, ErrLocked) {
		t.Fatalf("correct-while-locked: want ErrLocked, got %v", err)
	}
}

func TestLogoutInvalidatesSession(t *testing.T) {
	db := newTestDB(t)
	seedAdmin(t, db, "s3cret")
	svc := NewService(db, Config{})
	ctx := context.Background()

	token, _, err := svc.Login(ctx, "admin", "s3cret")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := svc.Logout(ctx, token); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := svc.ResolveSession(ctx, token); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("post-logout resolve: want ErrSessionInvalid, got %v", err)
	}
}

func TestVerifyPasswordRejectsWrong(t *testing.T) {
	hash, err := HashPassword("correct-horse")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	ok, err := VerifyPassword("correct-horse", hash)
	if err != nil || !ok {
		t.Fatalf("verify correct: ok=%v err=%v", ok, err)
	}
	ok, err = VerifyPassword("wrong", hash)
	if err != nil || ok {
		t.Fatalf("verify wrong: ok=%v err=%v", ok, err)
	}
}
