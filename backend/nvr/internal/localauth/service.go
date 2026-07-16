package localauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/neubit/nvr/internal/store"
)

// Repo is the persistence subset the login service needs (satisfied by
// *sqlitestore.DB). Narrowing it keeps the service unit-testable.
type Repo interface {
	GetLocalUserByName(ctx context.Context, username string) (store.LocalUser, error)
	GetLocalUserByID(ctx context.Context, id string) (store.LocalUser, error)
	UpdateLocalUser(ctx context.Context, u store.LocalUser) error
	CreateSession(ctx context.Context, s store.LocalSession) error
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (store.LocalSession, error)
	RevokeSession(ctx context.Context, id string) error
}

// Login/session failure modes (kept coarse so callers don't leak which check failed).
var (
	ErrInvalidCredentials = errors.New("localauth: invalid credentials")
	ErrLocked             = errors.New("localauth: account locked")
	ErrInactive           = errors.New("localauth: account inactive")
	ErrSessionInvalid     = errors.New("localauth: session invalid or expired")
)

// Config tunes session lifetime + lockout policy.
type Config struct {
	SessionTTL time.Duration // default 12h
	MaxFailed  int           // consecutive failures before lockout (default 5)
	LockFor    time.Duration // lockout duration (default 15m)
}

func (c Config) withDefaults() Config {
	if c.SessionTTL == 0 {
		c.SessionTTL = 12 * time.Hour
	}
	if c.MaxFailed == 0 {
		c.MaxFailed = 5
	}
	if c.LockFor == 0 {
		c.LockFor = 15 * time.Minute
	}
	return c
}

// Service issues local sessions for the standalone console.
type Service struct {
	repo Repo
	cfg  Config
	now  func() time.Time
}

// NewService builds the login service. now defaults to time.Now (overridable in tests).
func NewService(repo Repo, cfg Config) *Service {
	return &Service{repo: repo, cfg: cfg.withDefaults(), now: func() time.Time { return time.Now().UTC() }}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomHex(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Login verifies credentials and, on success, mints an opaque session token
// (only its sha256 is persisted). Failed attempts increment failed_login_count;
// at MaxFailed the account locks for LockFor.
func (s *Service) Login(ctx context.Context, username, password string) (string, store.LocalUser, error) {
	now := s.now()
	user, err := s.repo.GetLocalUserByName(ctx, username)
	if errors.Is(err, store.ErrNotFound) {
		return "", store.LocalUser{}, ErrInvalidCredentials
	}
	if err != nil {
		return "", store.LocalUser{}, err
	}
	if !user.IsActive {
		return "", store.LocalUser{}, ErrInactive
	}
	if user.LockedUntil != nil && user.LockedUntil.After(now) {
		return "", store.LocalUser{}, ErrLocked
	}

	ok, err := VerifyPassword(password, user.PasswordHash)
	if err != nil {
		return "", store.LocalUser{}, err // malformed stored hash = server error
	}
	if !ok {
		user.FailedLoginCount++
		justLocked := false
		if user.FailedLoginCount >= s.cfg.MaxFailed {
			until := now.Add(s.cfg.LockFor)
			user.LockedUntil = &until
			user.FailedLoginCount = 0
			justLocked = true
		}
		user.UpdatedAt = now
		if uerr := s.repo.UpdateLocalUser(ctx, user); uerr != nil {
			return "", store.LocalUser{}, uerr
		}
		if justLocked {
			return "", store.LocalUser{}, ErrLocked
		}
		return "", store.LocalUser{}, ErrInvalidCredentials
	}

	// Success — clear failure state, stamp last login.
	user.FailedLoginCount = 0
	user.LockedUntil = nil
	user.LastLoginAt = &now
	user.UpdatedAt = now
	if uerr := s.repo.UpdateLocalUser(ctx, user); uerr != nil {
		return "", store.LocalUser{}, uerr
	}

	token, err := randomHex(32)
	if err != nil {
		return "", store.LocalUser{}, err
	}
	sid, err := randomHex(16)
	if err != nil {
		return "", store.LocalUser{}, err
	}
	sess := store.LocalSession{
		ID:        sid,
		UserID:    user.ID,
		TokenHash: hashToken(token),
		ExpiresAt: now.Add(s.cfg.SessionTTL),
		CreatedAt: now,
	}
	if serr := s.repo.CreateSession(ctx, sess); serr != nil {
		return "", store.LocalUser{}, serr
	}
	return token, user, nil
}

// ResolveSession validates an opaque session token and returns its user.
func (s *Service) ResolveSession(ctx context.Context, token string) (store.LocalUser, error) {
	if token == "" {
		return store.LocalUser{}, ErrSessionInvalid
	}
	sess, err := s.repo.GetSessionByTokenHash(ctx, hashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return store.LocalUser{}, ErrSessionInvalid
	}
	if err != nil {
		return store.LocalUser{}, err
	}
	if sess.RevokedAt != nil || !sess.ExpiresAt.After(s.now()) {
		return store.LocalUser{}, ErrSessionInvalid
	}
	user, err := s.repo.GetLocalUserByID(ctx, sess.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return store.LocalUser{}, ErrSessionInvalid
	}
	if err != nil {
		return store.LocalUser{}, err
	}
	if !user.IsActive {
		return store.LocalUser{}, ErrInactive
	}
	return user, nil
}

// Logout revokes the session backing the token (no-op if unknown).
func (s *Service) Logout(ctx context.Context, token string) error {
	sess, err := s.repo.GetSessionByTokenHash(ctx, hashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.repo.RevokeSession(ctx, sess.ID)
}
