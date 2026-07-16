package estate

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/store"
)

// Permissions the PTZ estate endpoints gate on. Reads (list presets/patrols) take
// the lighter live-view perm — an operator viewing a camera can see its presets;
// writes (preset/patrol CRUD) need ptz.control. Same perm strings as the central
// control plane (vision/app/vms/ptz/router.py) so a central JWT works unchanged.
const (
	permPtzView    = "vms.live.view"
	permPtzControl = "vms.ptz.control"
)

// mountPtz wires the PTZ estate endpoints (spec §6.1 "PTZ"), mirroring the central
// control plane's shapes (vision/app/vms/ptz/router.py) so the same frontend API
// client works against the node with only a base-URL change:
//
//	GET|POST    /estate/cameras/{id}/ptz/presets
//	DELETE      /estate/cameras/{id}/ptz/presets/{preset_id}
//	POST        /estate/cameras/{id}/ptz/presets/{preset_id}/goto   (501 stub)
//	GET|POST    /estate/cameras/{id}/ptz/patrols
//	PATCH|DELETE/estate/cameras/{id}/ptz/patrols/{patrol_id}
//	POST        /estate/cameras/{id}/ptz/{move|stop}                (501 stub)
//
// Preset/patrol CRUD persist to the embedded store; device move/goto is a stub
// (501) until the driver seam lands. Every write records an audit_log row.
func mountPtz(r chi.Router, d *Deps) {
	h := &ptzHandler{d: d}
	r.Route("/cameras/{camera_id}/ptz", func(rr chi.Router) {
		// Device motion — not yet wired to a driver on the node.
		rr.With(localauth.RequirePerm(permPtzControl)).Post("/move", h.notImplemented)
		rr.With(localauth.RequirePerm(permPtzControl)).Post("/stop", h.notImplemented)

		// Presets.
		rr.With(localauth.RequirePerm(permPtzView)).Get("/presets", h.listPresets)
		rr.With(localauth.RequirePerm(permPtzControl)).Post("/presets", h.createPreset)
		rr.With(localauth.RequirePerm(permPtzControl)).Post("/presets/{preset_id}/goto", h.notImplemented)
		rr.With(localauth.RequirePerm(permPtzControl)).Delete("/presets/{preset_id}", h.deletePreset)

		// Patrols.
		rr.With(localauth.RequirePerm(permPtzView)).Get("/patrols", h.listPatrols)
		rr.With(localauth.RequirePerm(permPtzControl)).Post("/patrols", h.createPatrol)
		rr.With(localauth.RequirePerm(permPtzControl)).Patch("/patrols/{patrol_id}", h.updatePatrol)
		rr.With(localauth.RequirePerm(permPtzControl)).Delete("/patrols/{patrol_id}", h.deletePatrol)
	})
}

type ptzHandler struct{ d *Deps }

// notImplemented is the placeholder for device motion (move/stop/goto): the node
// stores presets/patrols but does not yet drive the camera. Returns 501 rather than
// a 500 so callers can distinguish "not built" from a real failure.
func (h *ptzHandler) notImplemented(w http.ResponseWriter, r *http.Request) {
	kerr.WriteCode(w, http.StatusNotImplemented, "not_implemented",
		"PTZ device control is not available on this node yet")
}

// ── Presets ──────────────────────────────────────────────────────────────

type presetCreate struct {
	Name        string          `json:"name"`
	PresetToken *string         `json:"preset_token"`
	Position    json.RawMessage `json:"position"`
}

func (h *ptzHandler) listPresets(w http.ResponseWriter, r *http.Request) {
	cameraID := chi.URLParam(r, "camera_id")
	items, err := h.d.DB.ListPtzPresets(r.Context(), cameraID)
	if err != nil {
		kerr.Write(w, kerr.Internal("list presets: "+err.Error()))
		return
	}
	if items == nil {
		items = []store.PtzPreset{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (h *ptzHandler) createPreset(w http.ResponseWriter, r *http.Request) {
	cameraID := chi.URLParam(r, "camera_id")
	var body presetCreate
	if err := decodeJSON(r, &body); err != nil {
		kerr.Write(w, kerr.BadRequest(err.Error()))
		return
	}
	if body.Name == "" {
		kerr.Write(w, kerr.Validation("name is required"))
		return
	}

	now := time.Now().UTC()
	p := store.PtzPreset{
		ID:          uuid.NewString(),
		CameraID:    cameraID,
		Name:        body.Name,
		PresetToken: body.PresetToken,
		Position:    body.Position,
		CreatedBy:   actorSubject(r),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.d.DB.CreatePtzPreset(r.Context(), p); err != nil {
		kerr.Write(w, kerr.Internal("create preset: "+err.Error()))
		return
	}
	h.audit(r, "ptz.preset.create", p.ID, map[string]any{"camera_id": cameraID, "name": p.Name})
	httpx.JSON(w, http.StatusCreated, p)
}

func (h *ptzHandler) deletePreset(w http.ResponseWriter, r *http.Request) {
	presetID := chi.URLParam(r, "preset_id")
	if err := h.d.DB.DeletePtzPreset(r.Context(), presetID); err != nil {
		if err == store.ErrNotFound {
			kerr.Write(w, kerr.NotFound("preset not found"))
			return
		}
		kerr.Write(w, kerr.Internal("delete preset: "+err.Error()))
		return
	}
	h.audit(r, "ptz.preset.delete", presetID, map[string]any{"camera_id": chi.URLParam(r, "camera_id")})
	w.WriteHeader(http.StatusNoContent)
}

// ── Patrols ──────────────────────────────────────────────────────────────

type patrolCreate struct {
	Name     string          `json:"name"`
	Stops    json.RawMessage `json:"stops"`
	Speed    float64         `json:"speed"`
	IsActive *bool           `json:"is_active"`
	Schedule json.RawMessage `json:"schedule"`
}

type patrolUpdate struct {
	Name     *string         `json:"name"`
	Stops    json.RawMessage `json:"stops"`
	Speed    *float64        `json:"speed"`
	IsActive *bool           `json:"is_active"`
	Schedule json.RawMessage `json:"schedule"`
}

func (h *ptzHandler) listPatrols(w http.ResponseWriter, r *http.Request) {
	cameraID := chi.URLParam(r, "camera_id")
	items, err := h.d.DB.ListPtzPatrols(r.Context(), cameraID)
	if err != nil {
		kerr.Write(w, kerr.Internal("list patrols: "+err.Error()))
		return
	}
	if items == nil {
		items = []store.PtzPatrol{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (h *ptzHandler) createPatrol(w http.ResponseWriter, r *http.Request) {
	cameraID := chi.URLParam(r, "camera_id")
	var body patrolCreate
	if err := decodeJSON(r, &body); err != nil {
		kerr.Write(w, kerr.BadRequest(err.Error()))
		return
	}
	if body.Name == "" {
		kerr.Write(w, kerr.Validation("name is required"))
		return
	}

	now := time.Now().UTC()
	active := true
	if body.IsActive != nil {
		active = *body.IsActive
	}
	p := store.PtzPatrol{
		ID:        uuid.NewString(),
		CameraID:  cameraID,
		Name:      body.Name,
		Stops:     body.Stops,
		Speed:     body.Speed,
		IsActive:  active,
		IsRunning: false,
		Schedule:  body.Schedule,
		CreatedBy: actorSubject(r),
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := h.d.DB.CreatePtzPatrol(r.Context(), p); err != nil {
		kerr.Write(w, kerr.Internal("create patrol: "+err.Error()))
		return
	}
	h.audit(r, "ptz.patrol.create", p.ID, map[string]any{"camera_id": cameraID, "name": p.Name})
	httpx.JSON(w, http.StatusCreated, p)
}

func (h *ptzHandler) updatePatrol(w http.ResponseWriter, r *http.Request) {
	cameraID := chi.URLParam(r, "camera_id")
	patrolID := chi.URLParam(r, "patrol_id")

	// Load the current row so PATCH is a partial merge (only supplied fields change).
	current, err := h.findPatrol(r, cameraID, patrolID)
	if err != nil {
		if err == store.ErrNotFound {
			kerr.Write(w, kerr.NotFound("patrol not found"))
			return
		}
		kerr.Write(w, kerr.Internal("load patrol: "+err.Error()))
		return
	}

	var body patrolUpdate
	if err := decodeJSON(r, &body); err != nil {
		kerr.Write(w, kerr.BadRequest(err.Error()))
		return
	}
	if body.Name != nil {
		current.Name = *body.Name
	}
	if body.Stops != nil {
		current.Stops = body.Stops
	}
	if body.Speed != nil {
		current.Speed = *body.Speed
	}
	if body.IsActive != nil {
		current.IsActive = *body.IsActive
	}
	if body.Schedule != nil {
		current.Schedule = body.Schedule
	}
	current.UpdatedAt = time.Now().UTC()

	if err := h.d.DB.UpdatePtzPatrol(r.Context(), current); err != nil {
		if err == store.ErrNotFound {
			kerr.Write(w, kerr.NotFound("patrol not found"))
			return
		}
		kerr.Write(w, kerr.Internal("update patrol: "+err.Error()))
		return
	}
	h.audit(r, "ptz.patrol.update", patrolID, map[string]any{"camera_id": cameraID, "name": current.Name})
	httpx.JSON(w, http.StatusOK, current)
}

func (h *ptzHandler) deletePatrol(w http.ResponseWriter, r *http.Request) {
	patrolID := chi.URLParam(r, "patrol_id")
	if err := h.d.DB.DeletePtzPatrol(r.Context(), patrolID); err != nil {
		if err == store.ErrNotFound {
			kerr.Write(w, kerr.NotFound("patrol not found"))
			return
		}
		kerr.Write(w, kerr.Internal("delete patrol: "+err.Error()))
		return
	}
	h.audit(r, "ptz.patrol.delete", patrolID, map[string]any{"camera_id": chi.URLParam(r, "camera_id")})
	w.WriteHeader(http.StatusNoContent)
}

// findPatrol locates one patrol scoped to its camera. The repo exposes a per-camera
// list (no single-row get), so filter that — it also naturally 404s a patrol that
// belongs to a different camera than the URL claims.
func (h *ptzHandler) findPatrol(r *http.Request, cameraID, patrolID string) (store.PtzPatrol, error) {
	items, err := h.d.DB.ListPtzPatrols(r.Context(), cameraID)
	if err != nil {
		return store.PtzPatrol{}, err
	}
	for _, p := range items {
		if p.ID == patrolID {
			return p, nil
		}
	}
	return store.PtzPatrol{}, store.ErrNotFound
}

// ── shared helpers ─────────────────────────────────────────────────────────

// decodeJSON strictly decodes a JSON request body into v (unknown fields rejected).
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// actorSubject returns the authenticated caller's subject (user/node id) for
// created_by / audit actor, or nil when the request somehow lacks a Caller.
func actorSubject(r *http.Request) *string {
	if c, ok := localauth.CallerFrom(r.Context()); ok && c.Subject != "" {
		s := c.Subject
		return &s
	}
	return nil
}

// audit appends an audit_log row for a write. Failures are swallowed (best-effort,
// same as node self endpoints) so an audit hiccup never fails the operation.
func (h *ptzHandler) audit(r *http.Request, action, target string, detail map[string]any) {
	kind := "system"
	if c, ok := localauth.CallerFrom(r.Context()); ok && c.Kind != "" {
		kind = c.Kind
	}
	raw, _ := json.Marshal(detail)
	t := target
	_ = h.d.DB.AppendAudit(r.Context(), store.AuditEntry{
		Actor:     actorSubject(r),
		ActorKind: kind,
		Action:    action,
		Target:    &t,
		Detail:    raw,
	})
}
