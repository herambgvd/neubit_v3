package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// UpsertNodeIdentity writes the single node_identity row (spec §4.13). The node
// has exactly one identity; the id is the primary key so a repeat write updates
// in place.
func (d *DB) UpsertNodeIdentity(ctx context.Context, id store.NodeIdentity) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO node_identity (
			id, name, tenant_id, central_base_url, node_credential, enroll_state,
			jwt_public_key, secret_key_enc, enrolled_at, last_sync_at, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name,
			tenant_id=excluded.tenant_id,
			central_base_url=excluded.central_base_url,
			node_credential=excluded.node_credential,
			enroll_state=excluded.enroll_state,
			jwt_public_key=excluded.jwt_public_key,
			secret_key_enc=excluded.secret_key_enc,
			enrolled_at=excluded.enrolled_at,
			last_sync_at=excluded.last_sync_at,
			updated_at=excluded.updated_at`,
		id.ID, id.Name, id.TenantID, id.CentralBaseURL, id.NodeCredential, id.EnrollState,
		id.JWTPublicKey, id.SecretKeyEnc, nullRFC(id.EnrolledAt), nullRFC(id.LastSyncAt),
		rfc(id.CreatedAt), rfc(id.UpdatedAt),
	)
	return err
}

// GetNodeIdentity returns the single node_identity row, or store.ErrNotFound
// when the node has not been bootstrapped.
func (d *DB) GetNodeIdentity(ctx context.Context) (store.NodeIdentity, error) {
	var (
		out                                       store.NodeIdentity
		tenantID, centralURL, cred, jwtKey, secKey sql.NullString
		enrolledAt, lastSync                      sql.NullString
		createdAt, updatedAt                      string
	)
	err := d.ro.QueryRowContext(ctx, `
		SELECT id, name, tenant_id, central_base_url, node_credential, enroll_state,
		       jwt_public_key, secret_key_enc, enrolled_at, last_sync_at, created_at, updated_at
		FROM node_identity LIMIT 1`).Scan(
		&out.ID, &out.Name, &tenantID, &centralURL, &cred, &out.EnrollState,
		&jwtKey, &secKey, &enrolledAt, &lastSync, &createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return store.NodeIdentity{}, store.ErrNotFound
	}
	if err != nil {
		return store.NodeIdentity{}, err
	}
	out.TenantID = strPtr(tenantID)
	out.CentralBaseURL = strPtr(centralURL)
	out.NodeCredential = strPtr(cred)
	out.JWTPublicKey = strPtr(jwtKey)
	out.SecretKeyEnc = strPtr(secKey)
	out.EnrolledAt = scanTime(enrolledAt)
	out.LastSyncAt = scanTime(lastSync)
	out.CreatedAt = mustTime(createdAt)
	out.UpdatedAt = mustTime(updatedAt)
	return out, nil
}
