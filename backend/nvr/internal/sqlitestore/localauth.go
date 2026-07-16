package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// ── local_users (spec §4.13) ─────────────────────────────────────────────────

// CreateLocalUser inserts a standalone-console account.
func (d *DB) CreateLocalUser(ctx context.Context, u store.LocalUser) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO local_users (
			id, username, full_name, password_hash, role, is_active, is_bootstrap,
			failed_login_count, locked_until, must_change_password, last_login_at,
			created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		u.ID, u.Username, u.FullName, u.PasswordHash, u.Role, b2i(u.IsActive), b2i(u.IsBootstrap),
		u.FailedLoginCount, nullRFC(u.LockedUntil), b2i(u.MustChangePassword), nullRFC(u.LastLoginAt),
		rfc(u.CreatedAt), rfc(u.UpdatedAt),
	)
	return err
}

func (d *DB) scanLocalUser(row interface{ Scan(...any) error }) (store.LocalUser, error) {
	var (
		u                                  store.LocalUser
		fullName                           sql.NullString
		lockedUntil, lastLogin             sql.NullString
		isActive, isBootstrap, mustChange  int
		createdAt, updatedAt               string
	)
	err := row.Scan(
		&u.ID, &u.Username, &fullName, &u.PasswordHash, &u.Role, &isActive, &isBootstrap,
		&u.FailedLoginCount, &lockedUntil, &mustChange, &lastLogin, &createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return store.LocalUser{}, store.ErrNotFound
	}
	if err != nil {
		return store.LocalUser{}, err
	}
	u.FullName = strPtr(fullName)
	u.IsActive = isActive == 1
	u.IsBootstrap = isBootstrap == 1
	u.MustChangePassword = mustChange == 1
	u.LockedUntil = scanTime(lockedUntil)
	u.LastLoginAt = scanTime(lastLogin)
	u.CreatedAt = mustTime(createdAt)
	u.UpdatedAt = mustTime(updatedAt)
	return u, nil
}

const localUserCols = `id, username, full_name, password_hash, role, is_active, is_bootstrap,
	failed_login_count, locked_until, must_change_password, last_login_at, created_at, updated_at`

// GetLocalUserByName returns the account with the given username (ErrNotFound if absent).
func (d *DB) GetLocalUserByName(ctx context.Context, username string) (store.LocalUser, error) {
	return d.scanLocalUser(d.ro.QueryRowContext(ctx,
		`SELECT `+localUserCols+` FROM local_users WHERE username=?`, username))
}

// GetLocalUserByID returns the account with the given id (ErrNotFound if absent).
func (d *DB) GetLocalUserByID(ctx context.Context, id string) (store.LocalUser, error) {
	return d.scanLocalUser(d.ro.QueryRowContext(ctx,
		`SELECT `+localUserCols+` FROM local_users WHERE id=?`, id))
}

// CountLocalUsers returns how many accounts exist (bootstrap uses this to detect
// a first boot).
func (d *DB) CountLocalUsers(ctx context.Context) (int, error) {
	var n int
	err := d.ro.QueryRowContext(ctx, `SELECT COUNT(*) FROM local_users`).Scan(&n)
	return n, err
}

// ListLocalUsers returns every standalone-console account, oldest first (stable
// order for the admin management screen).
func (d *DB) ListLocalUsers(ctx context.Context) ([]store.LocalUser, error) {
	rows, err := d.ro.QueryContext(ctx,
		`SELECT `+localUserCols+` FROM local_users ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]store.LocalUser, 0)
	for rows.Next() {
		u, err := d.scanLocalUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UpdateLocalUser writes mutable fields (login bookkeeping, role, active, password).
func (d *DB) UpdateLocalUser(ctx context.Context, u store.LocalUser) error {
	res, err := d.rw.ExecContext(ctx, `
		UPDATE local_users SET
			username=?, full_name=?, password_hash=?, role=?, is_active=?,
			failed_login_count=?, locked_until=?, must_change_password=?, last_login_at=?,
			updated_at=?
		WHERE id=?`,
		u.Username, u.FullName, u.PasswordHash, u.Role, b2i(u.IsActive),
		u.FailedLoginCount, nullRFC(u.LockedUntil), b2i(u.MustChangePassword), nullRFC(u.LastLoginAt),
		rfc(u.UpdatedAt), u.ID,
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// DeleteLocalUser removes an account (its sessions cascade). ErrNotFound if the
// id is unknown.
func (d *DB) DeleteLocalUser(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM local_users WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ── local_sessions (spec §4.13) ──────────────────────────────────────────────

// CreateSession stores an opaque session (only the sha256 token_hash is kept).
func (d *DB) CreateSession(ctx context.Context, s store.LocalSession) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO local_sessions (id, user_id, token_hash, expires_at, created_at, revoked_at)
		VALUES (?,?,?,?,?,?)`,
		s.ID, s.UserID, s.TokenHash, rfc(s.ExpiresAt), rfc(s.CreatedAt), nullRFC(s.RevokedAt),
	)
	return err
}

// GetSessionByTokenHash looks up a session by its sha256 hash (ErrNotFound if absent).
func (d *DB) GetSessionByTokenHash(ctx context.Context, tokenHash string) (store.LocalSession, error) {
	var (
		s                    store.LocalSession
		expiresAt, createdAt string
		revokedAt            sql.NullString
	)
	err := d.ro.QueryRowContext(ctx, `
		SELECT id, user_id, token_hash, expires_at, created_at, revoked_at
		FROM local_sessions WHERE token_hash=?`, tokenHash).Scan(
		&s.ID, &s.UserID, &s.TokenHash, &expiresAt, &createdAt, &revokedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return store.LocalSession{}, store.ErrNotFound
	}
	if err != nil {
		return store.LocalSession{}, err
	}
	s.ExpiresAt = mustTime(expiresAt)
	s.CreatedAt = mustTime(createdAt)
	s.RevokedAt = scanTime(revokedAt)
	return s, nil
}

// RevokeSession marks a session revoked (idempotent; unknown id is a no-op).
func (d *DB) RevokeSession(ctx context.Context, id string) error {
	_, err := d.rw.ExecContext(ctx,
		`UPDATE local_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL`,
		rfc(nowUTC()), id)
	return err
}
