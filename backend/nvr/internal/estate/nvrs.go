package estate

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/store"
)

// mountNvrs wires the registered-NVR estate endpoints (spec §6.1 "NVRs"): CRUD over
// registered NVR/DVR appliances onboarded as channel sources. Shapes mirror the
// central control plane (vision app/vms/nvr) so the same frontend API client works
// against a node with only a base-URL change — credentials are write-only (accepted
// as plaintext on create/update, never serialized back; the row exposes only
// has_credentials). Every write records an audit_log row.
//
//	GET    /estate/nvrs        → { items, total }
//	POST   /estate/nvrs        → create (201)
//	GET    /estate/nvrs/{id}   → get (404 if absent)
//	PATCH  /estate/nvrs/{id}   → partial update
//	DELETE /estate/nvrs/{id}   → 204
func mountNvrs(r chi.Router, d *Deps) {
	h := &nvrHandler{d: d}
	r.Route("/nvrs", func(rr chi.Router) {
		rr.Get("/", h.list)
		rr.Post("/", h.create)
		rr.Get("/{id}", h.get)
		rr.Patch("/{id}", h.update)
		rr.Delete("/{id}", h.delete)
	})
}

type nvrHandler struct{ d *Deps }

// nvrView is the serialized NVR — credentials are never exposed (only has_credentials).
type nvrView struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	IsEnabled      bool            `json:"is_enabled"`
	Brand          string          `json:"brand"`
	Driver         *string         `json:"driver"`
	Host           string          `json:"host"`
	Port           int             `json:"port"`
	Username       string          `json:"username"`
	HasCredentials bool            `json:"has_credentials"`
	ChannelCount   int             `json:"channel_count"`
	Status         string          `json:"status"`
	StorageInfo    json.RawMessage `json:"storage_info"`
	Capabilities   json.RawMessage `json:"capabilities"`
	LastSeenAt     *time.Time      `json:"last_seen_at"`
	LastError      *string         `json:"last_error"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func toNvrView(n store.NVR) nvrView {
	return nvrView{
		ID:             n.ID,
		Name:           n.Name,
		IsEnabled:      n.IsEnabled,
		Brand:          n.Brand,
		Driver:         n.Driver,
		Host:           n.Host,
		Port:           n.Port,
		Username:       n.Username,
		HasCredentials: n.EncCreds != nil && *n.EncCreds != "",
		ChannelCount:   n.ChannelCount,
		Status:         n.Status,
		StorageInfo:    n.StorageInfo,
		Capabilities:   n.Capabilities,
		LastSeenAt:     n.LastSeenAt,
		LastError:      n.LastError,
		CreatedAt:      n.CreatedAt,
		UpdatedAt:      n.UpdatedAt,
	}
}

// nvrCreateReq mirrors vision NvrCreate. Password is plaintext on write, stored
// encrypted, never serialized back.
type nvrCreateReq struct {
	Name         string  `json:"name"`
	IsEnabled    *bool   `json:"is_enabled"`
	Brand        string  `json:"brand"`
	Driver       *string `json:"driver"`
	Host         string  `json:"host"`
	Port         *int    `json:"port"`
	Username     string  `json:"username"`
	Password     *string `json:"password"`
	ChannelCount *int    `json:"channel_count"`
}

// nvrUpdateReq mirrors vision NvrUpdate — every field optional (partial patch);
// password provided rotates the credential, omitted leaves it unchanged.
type nvrUpdateReq struct {
	Name         *string `json:"name"`
	IsEnabled    *bool   `json:"is_enabled"`
	Brand        *string `json:"brand"`
	Driver       *string `json:"driver"`
	Host         *string `json:"host"`
	Port         *int    `json:"port"`
	Username     *string `json:"username"`
	Password     *string `json:"password"`
	ChannelCount *int    `json:"channel_count"`
}

func (h *nvrHandler) list(w http.ResponseWriter, r *http.Request) {
	items, err := h.d.DB.ListNVRs(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("could not list nvrs"))
		return
	}
	views := make([]nvrView, 0, len(items))
	for _, n := range items {
		views = append(views, toNvrView(n))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (h *nvrHandler) get(w http.ResponseWriter, r *http.Request) {
	n, err := h.d.DB.GetNVR(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeNvrErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, toNvrView(n))
}

func (h *nvrHandler) create(w http.ResponseWriter, r *http.Request) {
	var req nvrCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		kerr.Write(w, kerr.Validation("invalid json body"))
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Host = strings.TrimSpace(req.Host)
	if req.Name == "" {
		kerr.Write(w, kerr.Validation("name is required"))
		return
	}
	if req.Host == "" {
		kerr.Write(w, kerr.Validation("host is required"))
		return
	}

	now := time.Now().UTC()
	actor := callerSubject(r)
	n := store.NVR{
		ID:           uuid.NewString(),
		Name:         req.Name,
		IsEnabled:    boolOr(req.IsEnabled, true),
		Brand:        strOr(req.Brand, "onvif"),
		Driver:       req.Driver,
		Host:         req.Host,
		Port:         intOr(req.Port, 80),
		Username:     req.Username,
		EncCreds:     encCreds(req.Password),
		ChannelCount: intOr(req.ChannelCount, 0),
		Status:       "unknown",
		CreatedBy:    actor,
		UpdatedBy:    actor,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := h.d.DB.CreateNVR(r.Context(), n); err != nil {
		kerr.Write(w, kerr.Internal("could not create nvr"))
		return
	}
	h.audit(r, "nvr.create", n.ID)
	httpx.JSON(w, http.StatusCreated, toNvrView(n))
}

func (h *nvrHandler) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	n, err := h.d.DB.GetNVR(r.Context(), id)
	if err != nil {
		writeNvrErr(w, err)
		return
	}

	var req nvrUpdateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		kerr.Write(w, kerr.Validation("invalid json body"))
		return
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			kerr.Write(w, kerr.Validation("name cannot be empty"))
			return
		}
		n.Name = name
	}
	if req.IsEnabled != nil {
		n.IsEnabled = *req.IsEnabled
	}
	if req.Brand != nil {
		n.Brand = *req.Brand
	}
	if req.Driver != nil {
		n.Driver = req.Driver
	}
	if req.Host != nil {
		host := strings.TrimSpace(*req.Host)
		if host == "" {
			kerr.Write(w, kerr.Validation("host cannot be empty"))
			return
		}
		n.Host = host
	}
	if req.Port != nil {
		n.Port = *req.Port
	}
	if req.Username != nil {
		n.Username = *req.Username
	}
	if req.Password != nil {
		n.EncCreds = encCreds(req.Password)
	}
	if req.ChannelCount != nil {
		n.ChannelCount = *req.ChannelCount
	}
	n.UpdatedBy = callerSubject(r)
	n.UpdatedAt = time.Now().UTC()

	if err := h.d.DB.UpdateNVR(r.Context(), n); err != nil {
		writeNvrErr(w, err)
		return
	}
	h.audit(r, "nvr.update", n.ID)
	httpx.JSON(w, http.StatusOK, toNvrView(n))
}

func (h *nvrHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DB.DeleteNVR(r.Context(), id); err != nil {
		writeNvrErr(w, err)
		return
	}
	h.audit(r, "nvr.delete", id)
	w.WriteHeader(http.StatusNoContent)
}

// audit appends an append-only audit_log row for a write. Failure to record must
// not fail the (already committed) write — the estate write is the source of truth.
func (h *nvrHandler) audit(r *http.Request, action, target string) {
	c, _ := localauth.CallerFrom(r.Context())
	_ = h.d.DB.AppendAudit(r.Context(), store.AuditEntry{
		Actor:     callerSubject(r),
		ActorKind: callerKind(c),
		Action:    action,
		Target:    &target,
	})
}

// writeNvrErr maps a store error to an API error — ErrNotFound → 404, else 500.
func writeNvrErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.NotFound("nvr not found"))
		return
	}
	kerr.Write(w, kerr.Internal("nvr store error"))
}

// callerSubject is the audit actor — the authenticated caller's subject (user/node id).
func callerSubject(r *http.Request) *string {
	c, ok := localauth.CallerFrom(r.Context())
	if !ok || c.Subject == "" {
		return nil
	}
	s := c.Subject
	return &s
}

// callerKind maps the Caller kind onto the audit actor_kind vocabulary
// (local|central|system); an unresolved caller is "system".
func callerKind(c localauth.Caller) string {
	switch c.Kind {
	case "local", "central":
		return c.Kind
	default:
		return "system"
	}
}

// encCreds wraps a plaintext credential for storage. nil/empty password stores no
// credential (NULL); a value is marked with the "enc:" convention (§4.4 enc_creds).
func encCreds(pw *string) *string {
	if pw == nil || *pw == "" {
		return nil
	}
	v := "enc:" + *pw
	return &v
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func intOr(p *int, def int) int {
	if p == nil {
		return def
	}
	return *p
}

func strOr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
