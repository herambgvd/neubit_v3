package estate

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/store"
)

// mountRecording wires the recording-config estate endpoints (spec §6.1
// "Recording config"). The node is the authoritative owner of every camera's
// "what to record" facts, so GET/PUT read/write the camera's own recording
// columns (mode/schedule/fps/substream/retention/buffers/anr/audio) — the same
// shape the central control plane serves (vision/app/vms/cameras) so the frontend
// API client works against a node with only a base-URL change. start|stop are the
// manual trigger: they flip the desired recording_target the recording-supervisor
// reconciles, and — when a supervisor is wired into Deps — drive it directly.
//
//	GET|PUT /estate/cameras/{id}/recording          → recording config
//	POST    /estate/cameras/{id}/recording/start    → begin (manual trigger)
//	POST    /estate/cameras/{id}/recording/stop      → end
func mountRecording(r chi.Router, d *Deps) {
	h := &recordingHandler{d: d}
	r.Route("/cameras/{id}/recording", func(rr chi.Router) {
		rr.Get("/", h.get)
		rr.Put("/", h.put)
		rr.Post("/start", h.start)
		rr.Post("/stop", h.stop)
	})
}

type recordingHandler struct{ d *Deps }

// recordingConfig mirrors the central control plane's RecordingConfig
// (vision/app/vms/cameras/schemas.py) so one frontend client serves both. All
// fields optional on PUT (a partial config patches only what it carries).
type recordingConfig struct {
	Mode              *string          `json:"mode"`
	Schedule          *json.RawMessage `json:"schedule"`
	FPS               *int             `json:"fps"`
	RecordSubstream   *bool            `json:"record_substream"`
	RetentionDays     *int             `json:"retention_days"`
	PreBufferSeconds  *int             `json:"pre_buffer_seconds"`
	PostBufferSeconds *int             `json:"post_buffer_seconds"`
	AnrEnabled        *bool            `json:"anr_enabled"`
	AudioEnabled      *bool            `json:"audio_enabled"`
}

// recordingBody is the response shape (keys match the central GET's "recording"
// block so the frontend renders it identically).
func recordingBody(c store.Camera) map[string]any {
	return map[string]any{
		"camera_id":           c.ID,
		"mode":                c.RecordingMode,
		"schedule":            rawOrEmpty(c.RecordingSchedule),
		"fps":                 c.RecordingFPS,
		"record_substream":    c.RecordSubstream,
		"retention_days":      c.RetentionDays,
		"pre_buffer_seconds":  c.PreBufferSeconds,
		"post_buffer_seconds": c.PostBufferSeconds,
		"anr_enabled":         c.AnrEnabled,
		"audio_enabled":       c.AudioEnabled,
	}
}

// get returns the camera's recording configuration (404 if the camera is absent).
func (h *recordingHandler) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	c, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		kerr.Write(w, kerr.NotFound("camera not found"))
		return
	}
	httpx.JSON(w, http.StatusOK, recordingBody(c))
}

// put applies a (partial) recording config to the camera via GetCamera→apply→
// UpdateCamera, then records an audit row. Only the fields present in the body are
// changed. The recording-supervisor picks up the new intent on its next reconcile.
func (h *recordingHandler) put(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var cfg recordingConfig
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			kerr.Write(w, kerr.Validation("invalid recording config body"))
			return
		}
	}

	c, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		kerr.Write(w, kerr.NotFound("camera not found"))
		return
	}

	if cfg.Mode != nil {
		c.RecordingMode = *cfg.Mode
	}
	if cfg.Schedule != nil {
		c.RecordingSchedule = json.RawMessage(*cfg.Schedule)
	}
	if cfg.FPS != nil {
		c.RecordingFPS = cfg.FPS
	}
	if cfg.RecordSubstream != nil {
		c.RecordSubstream = *cfg.RecordSubstream
	}
	if cfg.RetentionDays != nil {
		c.RetentionDays = *cfg.RetentionDays
	}
	if cfg.PreBufferSeconds != nil {
		c.PreBufferSeconds = *cfg.PreBufferSeconds
	}
	if cfg.PostBufferSeconds != nil {
		c.PostBufferSeconds = *cfg.PostBufferSeconds
	}
	if cfg.AnrEnabled != nil {
		c.AnrEnabled = *cfg.AnrEnabled
	}
	if cfg.AudioEnabled != nil {
		c.AudioEnabled = *cfg.AudioEnabled
	}
	c.UpdatedAt = time.Now().UTC()
	c.UpdatedBy = actorPtr(r)

	if err := h.d.DB.UpdateCamera(r.Context(), c); err != nil {
		kerr.Write(w, kerr.Internal("could not update recording config"))
		return
	}
	h.audit(r, "recording.config", &id, recordingBody(c))
	httpx.JSON(w, http.StatusOK, recordingBody(c))
}

// start turns recording ON for the camera (manual trigger). It flips the desired
// recording_target the recording-supervisor reconciles against MediaMTX.
func (h *recordingHandler) start(w http.ResponseWriter, r *http.Request) {
	h.trigger(w, r, true)
}

// stop turns recording OFF for the camera (manual trigger). Idempotent.
func (h *recordingHandler) stop(w http.ResponseWriter, r *http.Request) {
	h.trigger(w, r, false)
}

// trigger is the shared start/stop body. In autonomous-node mode the recording-
// supervisor is repointed at this store, so the node-authoritative way to drive
// it is to flip the desired recording_target it reconciles (the SAME desired-state
// seam the internal recording routes ultimately write) — this keeps the manual
// trigger a pure store write with no dependency on the pgx-bound engine. Then audit.
func (h *recordingHandler) trigger(w http.ResponseWriter, r *http.Request, on bool) {
	id := chi.URLParam(r, "id")
	c, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		kerr.Write(w, kerr.NotFound("camera not found"))
		return
	}
	tenant := tenantForCamera(c)
	profile := recordingProfile(c)

	now := time.Now().UTC()
	if err := h.d.DB.UpsertRecordingTarget(r.Context(), store.RecordingTarget{
		TenantID:    tenant,
		CameraID:    id,
		Profile:     profile,
		PathName:    tenant + "/" + id + "/" + profile,
		Active:      on,
		TriggerType: "manual",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		kerr.Write(w, kerr.Internal("could not update recording target"))
		return
	}

	action := "recording.stop"
	if on {
		action = "recording.start"
	}
	h.audit(r, action, &id, map[string]any{"profile": profile, "active": on})
	httpx.JSON(w, http.StatusOK, map[string]any{"camera_id": id, "profile": profile, "recording": on})
}

// audit appends an append-only local audit row (best-effort — a trail write must
// never fail the operation the caller just completed).
func (h *recordingHandler) audit(r *http.Request, action string, target *string, detail map[string]any) {
	body, _ := json.Marshal(detail)
	_ = h.d.DB.AppendAudit(r.Context(), store.AuditEntry{
		Actor:     actorPtr(r),
		ActorKind: actorKind(r),
		Action:    action,
		Target:    target,
		Detail:    body,
	})
}

// tenantForCamera resolves the tenant used for recording path namespacing — the
// camera's own tenant, falling back to "platform" (mirrors the internal recording
// routes' tenantOf convention for a node with no central tenant).
func tenantForCamera(c store.Camera) string {
	if c.TenantID != nil && *c.TenantID != "" {
		return *c.TenantID
	}
	return "platform"
}

// recordingProfile picks the stream profile to record: the substream when the
// camera is configured to record it, else the main profile.
func recordingProfile(c store.Camera) string {
	if c.RecordSubstream {
		return "sub"
	}
	return "main"
}

// rawOrEmpty returns a JSON raw message or an empty object when nil/empty so the
// response always carries a well-formed "schedule" object.
func rawOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

// actorPtr resolves the authenticated caller's subject for audit/attribution.
func actorPtr(r *http.Request) *string {
	if c, ok := localauth.CallerFrom(r.Context()); ok && c.Subject != "" {
		s := c.Subject
		return &s
	}
	return nil
}

// actorKind maps the authenticated caller kind to an audit actor_kind.
func actorKind(r *http.Request) string {
	if c, ok := localauth.CallerFrom(r.Context()); ok && c.Kind != "" {
		return c.Kind
	}
	return "system"
}
