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

// mountCameras wires the camera estate endpoints (spec §6.1 "Cameras"). The
// request/response shapes mirror the central control plane
// (vision/app/vms/cameras) so the same frontend API client works against a node
// with only a base-URL change: list returns {items,total,skip,limit} of the
// nested CameraPublic shape, create/get/patch return one CameraPublic. Every
// write records an audit_log row.
func mountCameras(r chi.Router, d *Deps) {
	h := &cameraHandler{d: d}
	r.Get("/cameras", h.list)
	r.Post("/cameras", h.create)
	r.Get("/cameras/{id}", h.get)
	r.Patch("/cameras/{id}", h.update)
	r.Delete("/cameras/{id}", h.remove)
}

type cameraHandler struct{ d *Deps }

// ── request bodies (mirror CameraCreate / CameraUpdate) ──────────────────────

type onvifReq struct {
	Host         *string `json:"host"`
	Port         *int    `json:"port"`
	User         *string `json:"user"`
	Password     *string `json:"password"` // write-only plaintext
	ProfileToken *string `json:"profile_token"`
}

type recordingReq struct {
	Mode              *string         `json:"mode"`
	Schedule          json.RawMessage `json:"schedule"`
	FPS               *int            `json:"fps"`
	RecordSubstream   *bool           `json:"record_substream"`
	RetentionDays     *int            `json:"retention_days"`
	PreBufferSeconds  *int            `json:"pre_buffer_seconds"`
	PostBufferSeconds *int            `json:"post_buffer_seconds"`
	AnrEnabled        *bool           `json:"anr_enabled"`
	AudioEnabled      *bool           `json:"audio_enabled"`
}

type advancedReq struct {
	PrivacyMasks json.RawMessage `json:"privacy_masks"`
	MotionZones  json.RawMessage `json:"motion_zones"`
	MotionConfig json.RawMessage `json:"motion_config"`
	PosOverlay   json.RawMessage `json:"pos_overlay"`
	Dewarp       json.RawMessage `json:"dewarp"`
	Backchannel  json.RawMessage `json:"backchannel"`
}

type ptzReq struct {
	Capable *bool           `json:"capable"`
	Presets json.RawMessage `json:"presets"`
}

type placementReq struct {
	SiteID  *string `json:"site_id"`
	FloorID *string `json:"floor_id"`
	ZoneID  *string `json:"zone_id"`
}

type mediaProfileReq struct {
	Name       string  `json:"name"`
	Codec      *string `json:"codec"`
	Resolution *string `json:"resolution"`
	FPS        *int    `json:"fps"`
	RTSPPath   *string `json:"rtsp_path"`
	Bitrate    *int    `json:"bitrate"`
}

type cameraCreateBody struct {
	Name           string  `json:"name"`
	IsEnabled      *bool   `json:"is_enabled"`
	Brand          *string `json:"brand"`
	Driver         *string `json:"driver"`
	ConnectionType *string `json:"connection_type"`

	NetworkInfo json.RawMessage `json:"network_info"`
	Onvif       *onvifReq       `json:"onvif"`
	Recording   *recordingReq   `json:"recording"`
	Advanced    *advancedReq    `json:"advanced"`
	Ptz         *ptzReq         `json:"ptz"`
	Placement   *placementReq   `json:"placement"`

	MediaProfiles []mediaProfileReq `json:"media_profiles"`

	NvrID            *string `json:"nvr_id"`
	NvrChannelNumber *int    `json:"nvr_channel_number"`
	StoragePoolID    *string `json:"storage_pool_id"`
	MediaNodeID      *string `json:"media_node_id"`
	DisplayOrder     *int    `json:"display_order"`
}

// cameraUpdateBody carries only the mutable fields; every field is optional so an
// omitted key leaves the stored value untouched (a subset PATCH).
type cameraUpdateBody struct {
	Name           *string `json:"name"`
	IsEnabled      *bool   `json:"is_enabled"`
	Brand          *string `json:"brand"`
	Driver         *string `json:"driver"`
	ConnectionType *string `json:"connection_type"`

	NetworkInfo json.RawMessage `json:"network_info"`
	Onvif       *onvifReq       `json:"onvif"`
	Recording   *recordingReq   `json:"recording"`
	Advanced    *advancedReq    `json:"advanced"`
	Ptz         *ptzReq         `json:"ptz"`
	Placement   *placementReq   `json:"placement"`

	NvrID            *string `json:"nvr_id"`
	NvrChannelNumber *int    `json:"nvr_channel_number"`
	StoragePoolID    *string `json:"storage_pool_id"`
	MediaNodeID      *string `json:"media_node_id"`
	DisplayOrder     *int    `json:"display_order"`
}

// ── handlers ─────────────────────────────────────────────────────────────────

// list returns the cameras matching the query filters in the paged CameraPublic
// envelope. Filters (status/name/site/nvr) narrow at the store; name is a LIKE.
func (h *cameraHandler) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.CameraFilter{
		Status: q.Get("status"),
		Name:   firstNonEmpty(q.Get("q"), q.Get("name")),
		SiteID: firstNonEmpty(q.Get("site_id"), q.Get("site")),
		NvrID:  firstNonEmpty(q.Get("nvr_id"), q.Get("nvr")),
	}
	cams, err := h.d.DB.ListCameras(r.Context(), f)
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to list cameras"))
		return
	}
	items := make([]map[string]any, 0, len(cams))
	for i := range cams {
		// ListCameras does not join profiles; fetch per-camera so the shape is
		// complete (matches CameraPublic.media_profiles).
		profs, err := h.d.DB.ListMediaProfiles(r.Context(), cams[i].ID)
		if err != nil {
			kerr.Write(w, kerr.Internal("failed to list camera profiles"))
			return
		}
		cams[i].Profiles = profs
		items = append(items, cameraPublic(cams[i]))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": len(items),
		"skip":  0,
		"limit": len(items),
	})
}

// create inserts a camera (server generates the id, status="connecting") plus any
// operator-supplied media profiles, and records an audit_log row.
func (h *cameraHandler) create(w http.ResponseWriter, r *http.Request) {
	var body cameraCreateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		kerr.Write(w, kerr.BadRequest("name is required"))
		return
	}

	now := time.Now().UTC()
	actorID := actorRef(r)
	c := store.Camera{
		ID:             uuid.NewString(),
		Name:           body.Name,
		IsEnabled:      derefBool(body.IsEnabled, true),
		Status:         "connecting",
		Brand:          derefStr(body.Brand, "onvif"),
		Driver:         body.Driver,
		ConnectionType: derefStr(body.ConnectionType, "onvif"),
		NetworkInfo:    jsonOr(body.NetworkInfo, "{}"),
		// recording defaults (mirror RecordingConfig)
		RecordingMode:     "continuous",
		RecordingSchedule: json.RawMessage("{}"),
		RetentionDays:     30,
		PreBufferSeconds:  5,
		PostBufferSeconds: 5,
		// advanced defaults
		PrivacyMasks:      json.RawMessage("[]"),
		MotionZones:       json.RawMessage("[]"),
		MotionConfig:      json.RawMessage("{}"),
		PosOverlay:        json.RawMessage("{}"),
		Dewarp:            json.RawMessage("{}"),
		Backchannel:       json.RawMessage("{}"),
		PtzPresets:        json.RawMessage("[]"),
		OnvifCapabilities: json.RawMessage("{}"),
		OnvifEventTopics:  json.RawMessage("[]"),
		NvrID:             body.NvrID,
		NvrChannelNumber:  body.NvrChannelNumber,
		StoragePoolID:     body.StoragePoolID,
		MediaNodeID:       body.MediaNodeID,
		DisplayOrder:      derefInt(body.DisplayOrder, 0),
		CreatedBy:         actorID,
		UpdatedBy:         actorID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if body.Onvif != nil {
		c.OnvifHost = body.Onvif.Host
		c.OnvifPort = body.Onvif.Port
		c.OnvifUser = body.Onvif.User
		c.OnvifProfileToken = body.Onvif.ProfileToken
		if body.Onvif.Password != nil && *body.Onvif.Password != "" {
			enc := "enc:" + *body.Onvif.Password
			c.OnvifEncPass = &enc
		}
	}
	applyRecording(&c, body.Recording)
	applyAdvanced(&c, body.Advanced)
	applyPtz(&c, body.Ptz)
	applyPlacement(&c, body.Placement)

	if err := h.d.DB.CreateCamera(r.Context(), c); err != nil {
		kerr.Write(w, kerr.Internal("failed to create camera"))
		return
	}

	// Operator-supplied media profiles (explicit wins over any later probe).
	for _, mp := range body.MediaProfiles {
		p := store.MediaProfile{
			ID:         uuid.NewString(),
			TenantID:   c.TenantID,
			CameraID:   c.ID,
			Name:       defaultStr(mp.Name, "main"),
			Codec:      mp.Codec,
			Resolution: mp.Resolution,
			FPS:        mp.FPS,
			RTSPPath:   mp.RTSPPath,
			Bitrate:    mp.Bitrate,
			CreatedAt:  now,
			UpdatedAt:  now,
		}
		if err := h.d.DB.UpsertMediaProfile(r.Context(), p); err != nil {
			kerr.Write(w, kerr.Internal("failed to create media profile"))
			return
		}
	}

	h.audit(r, actorID, "camera.create", c.ID)

	full, err := h.d.DB.GetCamera(r.Context(), c.ID)
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to load created camera"))
		return
	}
	httpx.JSON(w, http.StatusCreated, cameraPublic(full))
}

// get returns one camera (with its media profiles) or 404.
func (h *cameraHandler) get(w http.ResponseWriter, r *http.Request) {
	c, err := h.d.DB.GetCamera(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeCameraErr(w, err, "failed to load camera")
		return
	}
	httpx.JSON(w, http.StatusOK, cameraPublic(c))
}

// update applies a subset PATCH to the mutable fields (get→apply→UpdateCamera),
// records an audit_log row, and returns the refreshed camera.
func (h *cameraHandler) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body cameraUpdateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}

	c, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		writeCameraErr(w, err, "failed to load camera")
		return
	}

	if body.Name != nil {
		c.Name = *body.Name
	}
	if body.IsEnabled != nil {
		c.IsEnabled = *body.IsEnabled
	}
	if body.Brand != nil {
		c.Brand = *body.Brand
	}
	if body.Driver != nil {
		c.Driver = body.Driver
	}
	if body.ConnectionType != nil {
		c.ConnectionType = *body.ConnectionType
	}
	if body.NetworkInfo != nil {
		c.NetworkInfo = body.NetworkInfo
	}
	if body.Onvif != nil {
		if body.Onvif.Host != nil {
			c.OnvifHost = body.Onvif.Host
		}
		if body.Onvif.Port != nil {
			c.OnvifPort = body.Onvif.Port
		}
		if body.Onvif.User != nil {
			c.OnvifUser = body.Onvif.User
		}
		if body.Onvif.ProfileToken != nil {
			c.OnvifProfileToken = body.Onvif.ProfileToken
		}
		if body.Onvif.Password != nil && *body.Onvif.Password != "" {
			enc := "enc:" + *body.Onvif.Password
			c.OnvifEncPass = &enc
		}
	}
	applyRecording(&c, body.Recording)
	applyAdvanced(&c, body.Advanced)
	applyPtz(&c, body.Ptz)
	applyPlacement(&c, body.Placement)
	if body.NvrID != nil {
		c.NvrID = body.NvrID
	}
	if body.NvrChannelNumber != nil {
		c.NvrChannelNumber = body.NvrChannelNumber
	}
	if body.StoragePoolID != nil {
		c.StoragePoolID = body.StoragePoolID
	}
	if body.MediaNodeID != nil {
		c.MediaNodeID = body.MediaNodeID
	}
	if body.DisplayOrder != nil {
		c.DisplayOrder = *body.DisplayOrder
	}

	actorID := actorRef(r)
	c.UpdatedBy = actorID
	c.UpdatedAt = time.Now().UTC()

	if err := h.d.DB.UpdateCamera(r.Context(), c); err != nil {
		writeCameraErr(w, err, "failed to update camera")
		return
	}
	h.audit(r, actorID, "camera.update", c.ID)

	full, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to reload camera"))
		return
	}
	httpx.JSON(w, http.StatusOK, cameraPublic(full))
}

// remove deletes a camera (profiles cascade), records an audit_log row, 204s.
func (h *cameraHandler) remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DB.DeleteCamera(r.Context(), id); err != nil {
		writeCameraErr(w, err, "failed to delete camera")
		return
	}
	h.audit(r, actorRef(r), "camera.delete", id)
	w.WriteHeader(http.StatusNoContent)
}

// ── shared helpers ───────────────────────────────────────────────────────────

// audit appends a best-effort audit_log row for a write (never fails the request).
func (h *cameraHandler) audit(r *http.Request, actor *string, action, target string) {
	kind := "system"
	if c, ok := localauth.CallerFrom(r.Context()); ok {
		kind = c.Kind
	}
	_ = h.d.DB.AppendAudit(r.Context(), store.AuditEntry{
		Actor:     actor,
		ActorKind: kind,
		Action:    action,
		Target:    &target,
	})
}

// applyRecording overlays the recording sub-object onto the camera (subset).
func applyRecording(c *store.Camera, b *recordingReq) {
	if b == nil {
		return
	}
	if b.Mode != nil {
		c.RecordingMode = *b.Mode
	}
	if b.Schedule != nil {
		c.RecordingSchedule = b.Schedule
	}
	if b.FPS != nil {
		c.RecordingFPS = b.FPS
	}
	if b.RecordSubstream != nil {
		c.RecordSubstream = *b.RecordSubstream
	}
	if b.RetentionDays != nil {
		c.RetentionDays = *b.RetentionDays
	}
	if b.PreBufferSeconds != nil {
		c.PreBufferSeconds = *b.PreBufferSeconds
	}
	if b.PostBufferSeconds != nil {
		c.PostBufferSeconds = *b.PostBufferSeconds
	}
	if b.AnrEnabled != nil {
		c.AnrEnabled = *b.AnrEnabled
	}
	if b.AudioEnabled != nil {
		c.AudioEnabled = *b.AudioEnabled
	}
}

func applyAdvanced(c *store.Camera, b *advancedReq) {
	if b == nil {
		return
	}
	if b.PrivacyMasks != nil {
		c.PrivacyMasks = b.PrivacyMasks
	}
	if b.MotionZones != nil {
		c.MotionZones = b.MotionZones
	}
	if b.MotionConfig != nil {
		c.MotionConfig = b.MotionConfig
	}
	if b.PosOverlay != nil {
		c.PosOverlay = b.PosOverlay
	}
	if b.Dewarp != nil {
		c.Dewarp = b.Dewarp
	}
	if b.Backchannel != nil {
		c.Backchannel = b.Backchannel
	}
}

func applyPtz(c *store.Camera, b *ptzReq) {
	if b == nil {
		return
	}
	if b.Capable != nil {
		c.PtzCapable = *b.Capable
	}
	if b.Presets != nil {
		c.PtzPresets = b.Presets
	}
}

func applyPlacement(c *store.Camera, b *placementReq) {
	if b == nil {
		return
	}
	if b.SiteID != nil {
		c.SiteID = b.SiteID
	}
	if b.FloorID != nil {
		c.FloorID = b.FloorID
	}
	if b.ZoneID != nil {
		c.ZoneID = b.ZoneID
	}
}

// cameraPublic renders a store.Camera into the nested CameraPublic JSON shape the
// frontend expects (mirrors CameraPublic.from_row) — onvif password is never
// serialized, only has_password.
func cameraPublic(c store.Camera) map[string]any {
	caps := rawObj(c.OnvifCapabilities)
	profiles := make([]map[string]any, 0, len(c.Profiles))
	for _, p := range c.Profiles {
		profiles = append(profiles, mediaProfilePublic(p))
	}
	return map[string]any{
		"id":              c.ID,
		"name":            c.Name,
		"is_enabled":      c.IsEnabled,
		"status":          c.Status,
		"brand":           c.Brand,
		"driver":          c.Driver,
		"connection_type": c.ConnectionType,
		"network_info":    rawObj(c.NetworkInfo),
		"onvif": map[string]any{
			"host":          c.OnvifHost,
			"port":          c.OnvifPort,
			"user":          c.OnvifUser,
			"has_password":  c.OnvifEncPass != nil,
			"profile_token": c.OnvifProfileToken,
			"capabilities":  caps,
		},
		"recording": map[string]any{
			"mode":                c.RecordingMode,
			"schedule":            rawObj(c.RecordingSchedule),
			"fps":                 c.RecordingFPS,
			"record_substream":    c.RecordSubstream,
			"retention_days":      c.RetentionDays,
			"pre_buffer_seconds":  c.PreBufferSeconds,
			"post_buffer_seconds": c.PostBufferSeconds,
			"anr_enabled":         c.AnrEnabled,
			"audio_enabled":       c.AudioEnabled,
		},
		"advanced": map[string]any{
			"privacy_masks": rawArr(c.PrivacyMasks),
			"motion_zones":  rawArr(c.MotionZones),
			"motion_config": rawObj(c.MotionConfig),
			"pos_overlay":   rawObj(c.PosOverlay),
			"dewarp":        rawObj(c.Dewarp),
			"backchannel":   rawObj(c.Backchannel),
		},
		"ptz": map[string]any{
			"capable": c.PtzCapable,
			"presets": rawArr(c.PtzPresets),
		},
		"placement": map[string]any{
			"site_id":  c.SiteID,
			"floor_id": c.FloorID,
			"zone_id":  c.ZoneID,
		},
		"media_profiles":     profiles,
		"nvr_id":             c.NvrID,
		"nvr_channel_number": c.NvrChannelNumber,
		"storage_pool_id":    c.StoragePoolID,
		"media_node_id":      c.MediaNodeID,
		"display_order":      c.DisplayOrder,
		"thumbnail_path":     c.ThumbnailPath,
		"last_seen_at":       c.LastSeenAt,
		"talk_capable":       caps["backchannel"] != nil,
		"sub_stream_codec":   c.SubStreamCodec,
		"web_codec_enforced": c.WebCodecEnforcedAt != nil,
		"created_at":         c.CreatedAt,
		"updated_at":         c.UpdatedAt,
	}
}

func mediaProfilePublic(p store.MediaProfile) map[string]any {
	return map[string]any{
		"id":         p.ID,
		"camera_id":  p.CameraID,
		"name":       p.Name,
		"codec":      p.Codec,
		"resolution": p.Resolution,
		"fps":        p.FPS,
		"rtsp_path":  p.RTSPPath,
		"bitrate":    p.Bitrate,
		"created_at": p.CreatedAt,
		"updated_at": p.UpdatedAt,
	}
}

// writeCameraErr maps a store error to 404 (ErrNotFound) or a 500 with msg.
func writeCameraErr(w http.ResponseWriter, err error, msg string) {
	if errors.Is(err, store.ErrNotFound) {
		kerr.Write(w, kerr.NotFound("camera not found"))
		return
	}
	kerr.Write(w, kerr.Internal(msg))
}

// actorRef returns the authenticated caller's subject as an audit actor ref.
func actorRef(r *http.Request) *string {
	if c, ok := localauth.CallerFrom(r.Context()); ok && c.Subject != "" {
		s := c.Subject
		return &s
	}
	return nil
}

// ── tiny value helpers ───────────────────────────────────────────────────────

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

func derefStr(p *string, def string) string {
	if p != nil {
		return *p
	}
	return def
}

func defaultStr(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func derefBool(p *bool, def bool) bool {
	if p != nil {
		return *p
	}
	return def
}

func derefInt(p *int, def int) int {
	if p != nil {
		return *p
	}
	return def
}

// jsonOr returns raw if it is non-empty JSON, else a parsed default literal.
func jsonOr(raw json.RawMessage, def string) json.RawMessage {
	if len(raw) > 0 {
		return raw
	}
	return json.RawMessage(def)
}

// rawObj decodes a JSON object column to a map for the response ({} when empty).
func rawObj(raw json.RawMessage) map[string]any {
	m := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &m)
	}
	return m
}

// rawArr decodes a JSON array column to a slice for the response ([] when empty).
func rawArr(raw json.RawMessage) []any {
	a := []any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &a)
	}
	return a
}
