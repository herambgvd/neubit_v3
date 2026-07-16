// Package identity handles the node's self: first-boot bootstrap (§5.1) and
// (Task 3.3) enrollment against central. Bootstrap makes an empty node.db a
// usable standalone appliance — a node identity, a crypto root for enc: fields,
// and a login-able bootstrap admin — with zero central contact.
package identity

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/store"
)

// Store is the persistence subset bootstrap needs (satisfied by *sqlitestore.DB).
type Store interface {
	GetNodeIdentity(ctx context.Context) (store.NodeIdentity, error)
	UpsertNodeIdentity(ctx context.Context, id store.NodeIdentity) error
	CountLocalUsers(ctx context.Context) (int, error)
	CreateLocalUser(ctx context.Context, u store.LocalUser) error
}

// Config carries install-time inputs (spec §5.1). Empty NodeSecret/AdminPassword
// are generated and surfaced once in Result so the installer can capture them.
type Config struct {
	NodeName      string // display name (default "neubit-node")
	NodeSecret    string // VE_NODE_SECRET — crypto root for enc: fields
	AdminUser     string // VE_NODE_ADMIN_USER (default "admin")
	AdminPassword string // VE_NODE_ADMIN_PASSWORD
}

// Result reports what bootstrap did. AlreadyBootstrapped=true means it was a
// no-op (identity present). GeneratedAdminPassword / GeneratedNodeSecret are
// non-empty only when this call generated them and the caller must log them once.
type Result struct {
	Identity              store.NodeIdentity
	AlreadyBootstrapped   bool
	GeneratedAdminPassword string
	GeneratedNodeSecret    string
}

func genSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Bootstrap ensures the node has an identity, a crypto root and a bootstrap admin.
// Idempotent: if an identity already exists it returns AlreadyBootstrapped without
// touching anything.
func Bootstrap(ctx context.Context, st Store, cfg Config) (Result, error) {
	existing, err := st.GetNodeIdentity(ctx)
	if err == nil {
		return Result{Identity: existing, AlreadyBootstrapped: true}, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return Result{}, err
	}

	now := time.Now().UTC()
	res := Result{}

	// Crypto root for enc: fields (generate if not supplied).
	secret := cfg.NodeSecret
	if secret == "" {
		secret, err = genSecret()
		if err != nil {
			return Result{}, err
		}
		res.GeneratedNodeSecret = secret
	}

	name := cfg.NodeName
	if name == "" {
		name = "neubit-node"
	}
	ident := store.NodeIdentity{
		ID:           uuid.NewString(),
		Name:         name,
		EnrollState:  "standalone",
		SecretKeyEnc: &secret,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := st.UpsertNodeIdentity(ctx, ident); err != nil {
		return Result{}, err
	}
	res.Identity = ident

	// Bootstrap admin — only if no local users exist yet (idempotent guard in case
	// a prior run wrote the identity but died before the admin).
	count, err := st.CountLocalUsers(ctx)
	if err != nil {
		return Result{}, err
	}
	if count == 0 {
		adminUser := cfg.AdminUser
		if adminUser == "" {
			adminUser = "admin"
		}
		adminPass := cfg.AdminPassword
		generated := false
		if adminPass == "" {
			adminPass, err = genSecret() // reuse: a strong random password
			if err != nil {
				return Result{}, err
			}
			generated = true
			res.GeneratedAdminPassword = adminPass
		}
		hash, err := localauth.HashPassword(adminPass)
		if err != nil {
			return Result{}, err
		}
		if err := st.CreateLocalUser(ctx, store.LocalUser{
			ID:                 uuid.NewString(),
			Username:           adminUser,
			PasswordHash:       hash,
			Role:               "admin",
			IsActive:           true,
			IsBootstrap:        true,
			MustChangePassword: generated, // force a change when we generated it
			CreatedAt:          now,
			UpdatedAt:          now,
		}); err != nil {
			return Result{}, err
		}
	}

	return res, nil
}
