package pgstore

import (
	"context"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// errEstateNodeOnly is returned by every estate/identity/local-auth method. These
// tables (cameras, media_profiles, nvrs, storage_pools, tier_rules, raid, ptz,
// local_users, local_sessions, node_identity) live ONLY in the embedded-SQLite
// node backend — central/Postgres mode addresses cameras through the Python
// `vision` control-plane and never reads them here. Calling one on pgstore is a
// wiring bug, so it fails loudly rather than silently returning empty.
var errEstateNodeOnly = errors.New("pgstore: estate methods are node/sqlite-only")

// estateUnimplemented supplies the node-only Store methods for pgstore. Embedding
// it lets PgStore hand-write only the engine subset yet still satisfy store.Store.
type estateUnimplemented struct{}

// --- node identity ---
func (estateUnimplemented) UpsertNodeIdentity(context.Context, store.NodeIdentity) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) GetNodeIdentity(context.Context) (store.NodeIdentity, error) {
	return store.NodeIdentity{}, errEstateNodeOnly
}

// --- local users + sessions ---
func (estateUnimplemented) CreateLocalUser(context.Context, store.LocalUser) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) GetLocalUserByName(context.Context, string) (store.LocalUser, error) {
	return store.LocalUser{}, errEstateNodeOnly
}
func (estateUnimplemented) GetLocalUserByID(context.Context, string) (store.LocalUser, error) {
	return store.LocalUser{}, errEstateNodeOnly
}
func (estateUnimplemented) CountLocalUsers(context.Context) (int, error) {
	return 0, errEstateNodeOnly
}
func (estateUnimplemented) UpdateLocalUser(context.Context, store.LocalUser) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) CreateSession(context.Context, store.LocalSession) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) GetSessionByTokenHash(context.Context, string) (store.LocalSession, error) {
	return store.LocalSession{}, errEstateNodeOnly
}
func (estateUnimplemented) RevokeSession(context.Context, string) error { return errEstateNodeOnly }

// --- cameras + media profiles ---
func (estateUnimplemented) CreateCamera(context.Context, store.Camera) error { return errEstateNodeOnly }
func (estateUnimplemented) GetCamera(context.Context, string) (store.Camera, error) {
	return store.Camera{}, errEstateNodeOnly
}
func (estateUnimplemented) ListCameras(context.Context, store.CameraFilter) ([]store.Camera, error) {
	return nil, errEstateNodeOnly
}
func (estateUnimplemented) UpdateCamera(context.Context, store.Camera) error { return errEstateNodeOnly }
func (estateUnimplemented) DeleteCamera(context.Context, string) error       { return errEstateNodeOnly }
func (estateUnimplemented) UpsertMediaProfile(context.Context, store.MediaProfile) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) ListMediaProfiles(context.Context, string) ([]store.MediaProfile, error) {
	return nil, errEstateNodeOnly
}

// --- nvrs ---
func (estateUnimplemented) CreateNVR(context.Context, store.NVR) error { return errEstateNodeOnly }
func (estateUnimplemented) GetNVR(context.Context, string) (store.NVR, error) {
	return store.NVR{}, errEstateNodeOnly
}
func (estateUnimplemented) ListNVRs(context.Context) ([]store.NVR, error) {
	return nil, errEstateNodeOnly
}
func (estateUnimplemented) UpdateNVR(context.Context, store.NVR) error { return errEstateNodeOnly }
func (estateUnimplemented) DeleteNVR(context.Context, string) error    { return errEstateNodeOnly }

// --- storage pools + tier rules + raid ---
func (estateUnimplemented) CreateStoragePool(context.Context, store.StoragePool) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) GetStoragePool(context.Context, string) (store.StoragePool, error) {
	return store.StoragePool{}, errEstateNodeOnly
}
func (estateUnimplemented) ListStoragePools(context.Context) ([]store.StoragePool, error) {
	return nil, errEstateNodeOnly
}
func (estateUnimplemented) UpdateStoragePool(context.Context, store.StoragePool) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) DeleteStoragePool(context.Context, string) error { return errEstateNodeOnly }
func (estateUnimplemented) CreateTierRule(context.Context, store.TierRule) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) ListTierRules(context.Context) ([]store.TierRule, error) {
	return nil, errEstateNodeOnly
}
func (estateUnimplemented) UpdateTierRule(context.Context, store.TierRule) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) DeleteTierRule(context.Context, string) error { return errEstateNodeOnly }
func (estateUnimplemented) UpsertRaidArray(context.Context, store.RaidArray) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) ListRaidArrays(context.Context) ([]store.RaidArray, error) {
	return nil, errEstateNodeOnly
}

// --- ptz ---
func (estateUnimplemented) CreatePtzPreset(context.Context, store.PtzPreset) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) ListPtzPresets(context.Context, string) ([]store.PtzPreset, error) {
	return nil, errEstateNodeOnly
}
func (estateUnimplemented) DeletePtzPreset(context.Context, string) error { return errEstateNodeOnly }
func (estateUnimplemented) CreatePtzPatrol(context.Context, store.PtzPatrol) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) ListPtzPatrols(context.Context, string) ([]store.PtzPatrol, error) {
	return nil, errEstateNodeOnly
}
func (estateUnimplemented) UpdatePtzPatrol(context.Context, store.PtzPatrol) error {
	return errEstateNodeOnly
}
func (estateUnimplemented) DeletePtzPatrol(context.Context, string) error { return errEstateNodeOnly }
