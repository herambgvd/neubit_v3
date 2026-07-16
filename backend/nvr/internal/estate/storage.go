package estate

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/hwstat"
	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/store"
)

// mountStorage wires the storage + tier + RAID estate endpoints (spec §6.1
// "Storage / RAID"). The request/response shapes mirror the central control plane
// (vision/app/vms/storage) so the same frontend API client works against a node
// with only a base-URL change:
//
//	GET|POST         /estate/storage/pools           list / create
//	GET|PATCH|DELETE /estate/storage/pools/{id}      get / update / delete
//	GET|POST         /estate/storage/tier-rules      list / create
//	PATCH|DELETE     /estate/storage/tier-rules/{id} update / delete
//	GET              /estate/storage/raid            md-array health (probe + upsert)
//	GET              /estate/storage/usage           disk usage of the recordings volume
//
// Every write appends an audit_log row (spec §5.4); reads never do.
func mountStorage(r chi.Router, d *Deps) {
	h := &storageHandler{d: d}
	r.Route("/storage", func(rr chi.Router) {
		rr.Get("/pools", h.listPools)
		rr.Post("/pools", h.createPool)
		rr.Get("/pools/{id}", h.getPool)
		rr.Patch("/pools/{id}", h.updatePool)
		rr.Delete("/pools/{id}", h.deletePool)

		rr.Get("/tier-rules", h.listRules)
		rr.Post("/tier-rules", h.createRule)
		rr.Patch("/tier-rules/{id}", h.updateRule)
		rr.Delete("/tier-rules/{id}", h.deleteRule)

		rr.Get("/raid", h.raid)
		rr.Get("/usage", h.usage)
	})
}

type storageHandler struct{ d *Deps }

// ── storage pools ────────────────────────────────────────────────────────────

// poolPublic is the read shape — secrets (NAS/S3) are never echoed, only a
// has-secret boolean (mirrors vision StoragePoolPublic).
type poolPublic struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	PoolType       string    `json:"pool_type"`
	Path           *string   `json:"path"`
	Priority       int       `json:"priority"`
	MaxSizeBytes   *int64    `json:"max_size_bytes"`
	IsDefault      bool      `json:"is_default"`
	IsActive       bool      `json:"is_active"`
	NasServer      *string   `json:"nas_server"`
	NasShare       *string   `json:"nas_share"`
	NasProtocol    *string   `json:"nas_protocol"`
	NasUsername    *string   `json:"nas_username"`
	NasDomain      *string   `json:"nas_domain"`
	MountState     *string   `json:"mount_state"`
	LastMountError *string   `json:"last_mount_error"`
	NasHasPassword bool      `json:"nas_has_password"`
	S3Endpoint     *string   `json:"s3_endpoint"`
	S3Bucket       *string   `json:"s3_bucket"`
	S3Region       *string   `json:"s3_region"`
	S3AccessKey    *string   `json:"s3_access_key"`
	S3UseSSL       bool      `json:"s3_use_ssl"`
	S3HasSecretKey bool      `json:"s3_has_secret_key"`
	RaidLevel      *string   `json:"raid_level"`
	RaidDevice     *string   `json:"raid_device"`
	Reachable      *bool     `json:"reachable"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func toPoolPublic(p store.StoragePool) poolPublic {
	return poolPublic{
		ID: p.ID, Name: p.Name, PoolType: p.PoolType, Path: p.Path, Priority: p.Priority,
		MaxSizeBytes: p.MaxSizeBytes, IsDefault: p.IsDefault, IsActive: p.IsActive,
		NasServer: p.NasServer, NasShare: p.NasShare, NasProtocol: p.NasProtocol,
		NasUsername: p.NasUsername, NasDomain: p.NasDomain, MountState: p.MountState,
		LastMountError: p.LastMountError, NasHasPassword: p.NasEncPassword != nil,
		S3Endpoint: p.S3Endpoint, S3Bucket: p.S3Bucket, S3Region: p.S3Region,
		S3AccessKey: p.S3AccessKey, S3UseSSL: p.S3UseSSL, S3HasSecretKey: p.S3EncSecretKey != nil,
		RaidLevel: p.RaidLevel, RaidDevice: p.RaidDevice, Reachable: p.Reachable,
		CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

// poolBody is the write shape (create/update). Pointers distinguish "absent" from
// a zero value on PATCH; create applies the same defaults the vision schema does.
type poolBody struct {
	Name            *string `json:"name"`
	PoolType        *string `json:"pool_type"`
	Path            *string `json:"path"`
	Priority        *int    `json:"priority"`
	MaxSizeBytes    *int64  `json:"max_size_bytes"`
	IsDefault       *bool   `json:"is_default"`
	IsActive        *bool   `json:"is_active"`
	NasServer       *string `json:"nas_server"`
	NasShare        *string `json:"nas_share"`
	NasProtocol     *string `json:"nas_protocol"`
	NasUsername     *string `json:"nas_username"`
	NasPassword     *string `json:"nas_password"`
	NasDomain       *string `json:"nas_domain"`
	NasMountOptions *string `json:"nas_mount_options"`
	S3Endpoint      *string `json:"s3_endpoint"`
	S3Bucket        *string `json:"s3_bucket"`
	S3Region        *string `json:"s3_region"`
	S3AccessKey     *string `json:"s3_access_key"`
	S3SecretKey     *string `json:"s3_secret_key"`
	S3UseSSL        *bool   `json:"s3_use_ssl"`
	RaidLevel       *string `json:"raid_level"`
	RaidDevice      *string `json:"raid_device"`
}

func (h *storageHandler) listPools(w http.ResponseWriter, r *http.Request) {
	pools, err := h.d.DB.ListStoragePools(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("could not list storage pools"))
		return
	}
	items := make([]poolPublic, 0, len(pools))
	for _, p := range pools {
		items = append(items, toPoolPublic(p))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (h *storageHandler) getPool(w http.ResponseWriter, r *http.Request) {
	p, err := h.d.DB.GetStoragePool(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeStorageErr(w, err, "storage pool not found")
		return
	}
	httpx.JSON(w, http.StatusOK, toPoolPublic(p))
}

func (h *storageHandler) createPool(w http.ResponseWriter, r *http.Request) {
	var body poolBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if body.Name == nil || *body.Name == "" {
		kerr.Write(w, kerr.Validation("name is required"))
		return
	}
	now := time.Now().UTC()
	actor := actorSubject(r)
	p := store.StoragePool{
		ID:        uuid.NewString(),
		Name:      *body.Name,
		PoolType:  "local",
		IsActive:  true,
		S3UseSSL:  true,
		CreatedBy: actor,
		UpdatedBy: actor,
		CreatedAt: now,
		UpdatedAt: now,
	}
	applyPoolBody(&p, body)

	if err := h.d.DB.CreateStoragePool(r.Context(), p); err != nil {
		kerr.Write(w, kerr.Internal("could not create storage pool"))
		return
	}
	h.audit(r, "storage.pool.create", "storage_pool:"+p.ID, map[string]any{
		"name": p.Name, "pool_type": p.PoolType,
	})
	httpx.JSON(w, http.StatusCreated, toPoolPublic(p))
}

func (h *storageHandler) updatePool(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	p, err := h.d.DB.GetStoragePool(r.Context(), id)
	if err != nil {
		writeStorageErr(w, err, "storage pool not found")
		return
	}
	var body poolBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	applyPoolBody(&p, body)
	p.UpdatedBy = actorSubject(r)
	p.UpdatedAt = time.Now().UTC()

	if err := h.d.DB.UpdateStoragePool(r.Context(), p); err != nil {
		writeStorageErr(w, err, "storage pool not found")
		return
	}
	h.audit(r, "storage.pool.update", "storage_pool:"+id, map[string]any{"name": p.Name})
	httpx.JSON(w, http.StatusOK, toPoolPublic(p))
}

func (h *storageHandler) deletePool(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DB.DeleteStoragePool(r.Context(), id); err != nil {
		writeStorageErr(w, err, "storage pool not found")
		return
	}
	h.audit(r, "storage.pool.delete", "storage_pool:"+id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// applyPoolBody copies present fields from a write body onto the pool. NasPassword
// / S3SecretKey are write-only secrets: they are stored as-is (encryption at rest
// is the pool-secret concern of the recording/mount layer, not this handler).
func applyPoolBody(p *store.StoragePool, b poolBody) {
	if b.Name != nil {
		p.Name = *b.Name
	}
	if b.PoolType != nil {
		p.PoolType = *b.PoolType
	}
	if b.Path != nil {
		p.Path = b.Path
	}
	if b.Priority != nil {
		p.Priority = *b.Priority
	}
	if b.MaxSizeBytes != nil {
		p.MaxSizeBytes = b.MaxSizeBytes
	}
	if b.IsDefault != nil {
		p.IsDefault = *b.IsDefault
	}
	if b.IsActive != nil {
		p.IsActive = *b.IsActive
	}
	if b.NasServer != nil {
		p.NasServer = b.NasServer
	}
	if b.NasShare != nil {
		p.NasShare = b.NasShare
	}
	if b.NasProtocol != nil {
		p.NasProtocol = b.NasProtocol
	}
	if b.NasUsername != nil {
		p.NasUsername = b.NasUsername
	}
	if b.NasPassword != nil {
		p.NasEncPassword = b.NasPassword
	}
	if b.NasDomain != nil {
		p.NasDomain = b.NasDomain
	}
	if b.NasMountOptions != nil {
		p.NasMountOptions = b.NasMountOptions
	}
	if b.S3Endpoint != nil {
		p.S3Endpoint = b.S3Endpoint
	}
	if b.S3Bucket != nil {
		p.S3Bucket = b.S3Bucket
	}
	if b.S3Region != nil {
		p.S3Region = b.S3Region
	}
	if b.S3AccessKey != nil {
		p.S3AccessKey = b.S3AccessKey
	}
	if b.S3SecretKey != nil {
		p.S3EncSecretKey = b.S3SecretKey
	}
	if b.S3UseSSL != nil {
		p.S3UseSSL = *b.S3UseSSL
	}
	if b.RaidLevel != nil {
		p.RaidLevel = b.RaidLevel
	}
	if b.RaidDevice != nil {
		p.RaidDevice = b.RaidDevice
	}
}

// ── tier rules ───────────────────────────────────────────────────────────────

type tierPublic struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	SourcePoolID  string     `json:"source_pool_id"`
	TargetPoolID  string     `json:"target_pool_id"`
	AfterAgeHours int        `json:"after_age_hours"`
	Enabled       bool       `json:"enabled"`
	LastRunAt     *time.Time `json:"last_run_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

func toTierPublic(t store.TierRule) tierPublic {
	return tierPublic{
		ID: t.ID, Name: t.Name, SourcePoolID: t.SourcePoolID, TargetPoolID: t.TargetPoolID,
		AfterAgeHours: t.AfterAgeHours, Enabled: t.Enabled, LastRunAt: t.LastRunAt,
		CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
	}
}

type tierBody struct {
	Name          *string `json:"name"`
	SourcePoolID  *string `json:"source_pool_id"`
	TargetPoolID  *string `json:"target_pool_id"`
	AfterAgeHours *int    `json:"after_age_hours"`
	Enabled       *bool   `json:"enabled"`
}

func (h *storageHandler) listRules(w http.ResponseWriter, r *http.Request) {
	rules, err := h.d.DB.ListTierRules(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("could not list tier rules"))
		return
	}
	items := make([]tierPublic, 0, len(rules))
	for _, t := range rules {
		items = append(items, toTierPublic(t))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (h *storageHandler) createRule(w http.ResponseWriter, r *http.Request) {
	var body tierBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if body.Name == nil || *body.Name == "" {
		kerr.Write(w, kerr.Validation("name is required"))
		return
	}
	if body.SourcePoolID == nil || body.TargetPoolID == nil {
		kerr.Write(w, kerr.Validation("source_pool_id and target_pool_id are required"))
		return
	}
	now := time.Now().UTC()
	actor := actorSubject(r)
	t := store.TierRule{
		ID:           uuid.NewString(),
		Name:         *body.Name,
		SourcePoolID: *body.SourcePoolID,
		TargetPoolID: *body.TargetPoolID,
		Enabled:      true,
		CreatedBy:    actor,
		UpdatedBy:    actor,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if body.AfterAgeHours != nil {
		t.AfterAgeHours = *body.AfterAgeHours
	}
	if body.Enabled != nil {
		t.Enabled = *body.Enabled
	}
	if err := h.d.DB.CreateTierRule(r.Context(), t); err != nil {
		kerr.Write(w, kerr.Internal("could not create tier rule"))
		return
	}
	h.audit(r, "storage.tier_rule.create", "tier_rule:"+t.ID, map[string]any{"name": t.Name})
	httpx.JSON(w, http.StatusCreated, toTierPublic(t))
}

func (h *storageHandler) updateRule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rules, err := h.d.DB.ListTierRules(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("could not load tier rule"))
		return
	}
	var t store.TierRule
	found := false
	for _, cur := range rules {
		if cur.ID == id {
			t, found = cur, true
			break
		}
	}
	if !found {
		kerr.Write(w, kerr.NotFound("tier rule not found"))
		return
	}
	var body tierBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if body.Name != nil {
		t.Name = *body.Name
	}
	if body.SourcePoolID != nil {
		t.SourcePoolID = *body.SourcePoolID
	}
	if body.TargetPoolID != nil {
		t.TargetPoolID = *body.TargetPoolID
	}
	if body.AfterAgeHours != nil {
		t.AfterAgeHours = *body.AfterAgeHours
	}
	if body.Enabled != nil {
		t.Enabled = *body.Enabled
	}
	t.UpdatedBy = actorSubject(r)
	t.UpdatedAt = time.Now().UTC()

	if err := h.d.DB.UpdateTierRule(r.Context(), t); err != nil {
		writeStorageErr(w, err, "tier rule not found")
		return
	}
	h.audit(r, "storage.tier_rule.update", "tier_rule:"+id, map[string]any{"name": t.Name})
	httpx.JSON(w, http.StatusOK, toTierPublic(t))
}

func (h *storageHandler) deleteRule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DB.DeleteTierRule(r.Context(), id); err != nil {
		writeStorageErr(w, err, "tier rule not found")
		return
	}
	h.audit(r, "storage.tier_rule.delete", "tier_rule:"+id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// ── RAID + disk usage ────────────────────────────────────────────────────────

// raid probes the local md arrays, upserts each into raid_arrays (so the health is
// persisted for the outbound sync), and returns them. Graceful everywhere: a box
// without software RAID reports available:false with an empty array list, never a
// 500.
func (h *storageHandler) raid(w http.ResponseWriter, r *http.Request) {
	arrays, err := hwstat.RaidArrays()
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"available": false, "reason": err.Error(), "arrays": []store.RaidArray{},
		})
		return
	}
	for _, a := range arrays {
		// Best-effort persist; a write failure must not fail the read.
		_ = h.d.DB.UpsertRaidArray(r.Context(), a)
	}
	stored, err := h.d.DB.ListRaidArrays(r.Context())
	if err != nil {
		stored = arrays // fall back to the fresh probe if the read-back fails
	}
	if stored == nil {
		stored = []store.RaidArray{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"available": len(stored) > 0,
		"arrays":    stored,
	})
}

// usage returns filesystem usage of the recordings volume (env VE_RECORDINGS_DIR),
// the primary "is the disk full?" signal — independent of RAID type.
func (h *storageHandler) usage(w http.ResponseWriter, r *http.Request) {
	recDir := os.Getenv("VE_RECORDINGS_DIR")
	if recDir == "" {
		recDir = "/recordings"
	}
	u, err := hwstat.Disk(recDir)
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"path": recDir, "reachable": false, "error": err.Error(),
		})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"path":         u.Path,
		"total_bytes":  u.TotalBytes,
		"free_bytes":   u.FreeBytes,
		"used_bytes":   u.UsedBytes,
		"used_percent": u.UsedPercent,
		"reachable":    true,
	})
}

// ── helpers ──────────────────────────────────────────────────────────────────

// audit appends a best-effort audit_log row for a write. A failure to record the
// audit never fails the request — the write already succeeded.
func (h *storageHandler) audit(r *http.Request, action, target string, detail map[string]any) {
	e := store.AuditEntry{
		Action:    action,
		Target:    &target,
		ActorKind: "system",
	}
	if c, ok := localauth.CallerFrom(r.Context()); ok {
		e.Actor = &c.Subject
		e.ActorKind = c.Kind
	}
	if detail != nil {
		if b, err := json.Marshal(detail); err == nil {
			e.Detail = b
		}
	}
	_ = h.d.DB.AppendAudit(r.Context(), e)
}

// writeStorageErr maps a store error to a 404 (ErrNotFound) or a 500 otherwise.
func writeStorageErr(w http.ResponseWriter, err error, notFoundMsg string) {
	if errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.NotFound(notFoundMsg))
		return
	}
	kerr.Write(w, kerr.Internal("storage store error"))
}
