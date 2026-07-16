package estate

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/mediamtx"
	"github.com/neubit/nvr/internal/mediatoken"
	"github.com/neubit/nvr/internal/store"
)

// mountLive wires the node-issued live / playback / recordings estate endpoints
// (spec §5.5 + §6.1 "Live / playback"). Unlike the internal streams/playback
// routes — which are called by the central `vision` control plane and reach the
// pgx-bound stream-supervisor — these run in autonomous-node mode: the node mints
// its OWN media token (mediatoken, HS256 with the node anchor secret) and returns
// browser-facing HLS/WHEP/playback URLs built from the node's public media base
// (VE_MEDIA_PUBLIC_HLS_BASE / _WHEP_BASE / _PLAYBACK_BASE), token appended as
// ?token=<t>. The same response shape the central plane returns (session_id,
// camera_id, profile, hls_url, webrtc_url, token, expires_at) so the frontend API
// client works against a node with only a base-URL change.
//
//	POST /estate/cameras/{id}/live       → mint a live media token + HLS/WHEP URLs
//	POST /estate/cameras/{id}/playback   → resolve coverage + mint a playback token
//	GET  /estate/recordings              → list the local recording-segment index
//
// These sit UNDER the estate auth middleware (a management action). The public
// /media/verify ForwardAuth hot path (mediaverify.go) authorises the minted token.
func mountLive(r chi.Router, d *Deps) {
	h := &liveHandler{d: d}
	r.Post("/cameras/{id}/live", h.startLive)
	r.Post("/cameras/{id}/playback", h.startPlayback)
	r.Get("/recordings", h.recordings)
}

type liveHandler struct{ d *Deps }

// mediaBase returns a trimmed public media base URL from env, falling back to def.
func mediaBase(envKey, def string) string {
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		return strings.TrimRight(v, "/")
	}
	return def
}

// appendToken adds ?token=<t> (or &token=) to a URL so the browser's HLS/WHEP
// requests carry the media token /media/verify validates. Mirrors vision's
// _append_token (v2 token-in-query pattern).
func appendToken(u, token string) string {
	if u == "" {
		return u
	}
	sep := "?"
	if strings.Contains(u, "?") {
		sep = "&"
	}
	return u + sep + "token=" + url.QueryEscape(token)
}

// startLive mints a live media token for the camera and returns the browser-facing
// HLS + WHEP URLs (public media base + MediaMTX path name + token). The path is
// pulled on-demand by MediaMTX on the first reader, so no supervisor call is
// needed here — the node authorises playback via the token alone. Records an
// audit_log row for the session start (best-effort).
func (h *liveHandler) startLive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	c, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		writeCameraErr(w, err, "failed to load camera")
		return
	}
	tenant := tenantForCamera(c)
	profile := liveProfile(c)
	name := mediamtx.PathName(tenant, id, profile)
	sessionID := uuid.NewString()

	token, exp, err := mediatoken.Mint(id, tenant, sessionID, "live", 0)
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to mint media token"))
		return
	}

	hls := appendToken(mediaBase("VE_MEDIA_PUBLIC_HLS_BASE", "/hls")+"/"+name+"/index.m3u8", token)
	whep := appendToken(mediaBase("VE_MEDIA_PUBLIC_WHEP_BASE", "/whep")+"/"+name+"/whep", token)

	h.audit(r, "live.start", &id, map[string]any{"session_id": sessionID, "profile": profile})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"session_id": sessionID,
		"camera_id":  id,
		"kind":       "live",
		"profile":    profile,
		"hls_url":    hls,
		"webrtc_url": whep,
		"token":      token,
		"expires_at": exp.UTC(),
		"ready":      false,
	})
}

// playbackBody is the {from,to} window the playback session covers (RFC3339).
type playbackBody struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// startPlayback resolves the camera's recorded coverage in [from,to] (the local
// segment index), mints a playback media token, and returns the browser-facing
// playback /get URL (public playback base + path name + window + token). No
// recordings in the window → a 200 with an empty playback_url + ranges (never a
// 404/500), so the caller can distinguish "no footage" from an error.
func (h *liveHandler) startPlayback(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var body playbackBody
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			kerr.Write(w, kerr.Validation("invalid playback window body"))
			return
		}
	}
	from, err := parseOptRFC3339(body.From)
	if err != nil {
		kerr.Write(w, kerr.Validation("invalid 'from' — expected RFC3339"))
		return
	}
	to, err := parseOptRFC3339(body.To)
	if err != nil {
		kerr.Write(w, kerr.Validation("invalid 'to' — expected RFC3339"))
		return
	}

	c, err := h.d.DB.GetCamera(r.Context(), id)
	if err != nil {
		writeCameraErr(w, err, "failed to load camera")
		return
	}
	tenant := tenantForCamera(c)
	profile := recordingProfile(c)
	name := mediamtx.PathName(tenant, id, profile)

	segs, err := h.d.DB.ListSegments(r.Context(), store.SegmentFilter{
		CameraID: id, Profile: profile, From: from, To: to,
	})
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to resolve recorded coverage"))
		return
	}
	ranges := segmentRanges(segs)

	sessionID := uuid.NewString()
	token, exp, err := mediatoken.Mint(id, tenant, sessionID, "playback", 0)
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to mint media token"))
		return
	}

	// The playback /get URL plays a window; prefer the explicit [from,to], else
	// span the recorded coverage we found. With no coverage there is nothing to
	// serve — leave playback_url empty.
	startISO, durationSec, ok := playbackWindow(from, to, segs)
	var playbackURL string
	if ok {
		base := mediaBase("VE_MEDIA_PUBLIC_PLAYBACK_BASE", "/playback")
		u := base + "/get?path=" + url.QueryEscape(name) +
			"&start=" + url.QueryEscape(startISO) +
			"&duration=" + formatSeconds(durationSec)
		playbackURL = appendToken(u, token)
	}

	h.audit(r, "playback.start", &id, map[string]any{"session_id": sessionID, "profile": profile})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"session_id":   sessionID,
		"camera_id":    id,
		"kind":         "playback",
		"profile":      profile,
		"ranges":       ranges,
		"playback_url": playbackURL,
		"token":        token,
		"expires_at":   exp.UTC(),
	})
}

// recordings lists the local recording-segment index for a camera in a window
// (spec §6.1). camera_id is required; from/to are optional RFC3339 bounds.
func (h *liveHandler) recordings(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cameraID := q.Get("camera_id")
	if strings.TrimSpace(cameraID) == "" {
		kerr.Write(w, kerr.Validation("camera_id is required"))
		return
	}
	from, err := parseOptRFC3339(q.Get("from"))
	if err != nil {
		kerr.Write(w, kerr.Validation("invalid 'from' — expected RFC3339"))
		return
	}
	to, err := parseOptRFC3339(q.Get("to"))
	if err != nil {
		kerr.Write(w, kerr.Validation("invalid 'to' — expected RFC3339"))
		return
	}

	segs, err := h.d.DB.ListSegments(r.Context(), store.SegmentFilter{
		CameraID: cameraID, Profile: q.Get("profile"), From: from, To: to,
	})
	if err != nil {
		kerr.Write(w, kerr.Internal("failed to list recordings"))
		return
	}
	items := make([]map[string]any, 0, len(segs))
	for _, s := range segs {
		items = append(items, segmentPublic(s))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": len(items),
	})
}

// audit appends a best-effort audit_log row (never fails the request).
func (h *liveHandler) audit(r *http.Request, action string, target *string, detail map[string]any) {
	body, _ := json.Marshal(detail)
	_ = h.d.DB.AppendAudit(r.Context(), store.AuditEntry{
		Actor:     actorPtr(r),
		ActorKind: actorKind(r),
		Action:    action,
		Target:    target,
		Detail:    body,
	})
}

// ── coverage helpers ─────────────────────────────────────────────────────────

// segmentRange is one recorded coverage span in a playback response.
type segmentRange struct {
	Start    time.Time `json:"start"`
	Duration float64   `json:"duration"`
}

// segmentRanges maps recorded segments (with a start + duration) into the coverage
// ranges the frontend seekbar renders. Segments without a start are skipped.
func segmentRanges(segs []store.RecordingSegment) []segmentRange {
	out := make([]segmentRange, 0, len(segs))
	for _, s := range segs {
		if s.StartedAt == nil {
			continue
		}
		var dur float64
		if s.Duration != nil {
			dur = *s.Duration
		} else if s.EndedAt != nil {
			dur = s.EndedAt.Sub(*s.StartedAt).Seconds()
		}
		out = append(out, segmentRange{Start: s.StartedAt.UTC(), Duration: dur})
	}
	return out
}

// playbackWindow resolves the (startISO, durationSec) the /get URL should serve:
// an explicit [from,to] window wins; otherwise span the recorded segments' first
// start to last end. ok=false when there is nothing to serve.
func playbackWindow(from, to *time.Time, segs []store.RecordingSegment) (string, float64, bool) {
	if from != nil && to != nil && to.After(*from) {
		return from.UTC().Format(time.RFC3339Nano), to.Sub(*from).Seconds(), true
	}
	ranges := segmentRanges(segs)
	if len(ranges) == 0 {
		return "", 0, false
	}
	start := ranges[0].Start
	last := ranges[len(ranges)-1]
	end := last.Start.Add(time.Duration(last.Duration * float64(time.Second)))
	if from != nil && from.After(start) {
		start = *from
	}
	if to != nil && to.Before(end) {
		end = *to
	}
	dur := end.Sub(start).Seconds()
	if dur <= 0 {
		return "", 0, false
	}
	return start.UTC().Format(time.RFC3339Nano), dur, true
}

// segmentPublic renders a recording segment into the list response shape.
func segmentPublic(s store.RecordingSegment) map[string]any {
	return map[string]any{
		"path":             s.Path,
		"camera_id":        s.CameraID,
		"profile":          s.Profile,
		"started_at":       s.StartedAt,
		"ended_at":         s.EndedAt,
		"duration":         s.Duration,
		"file_size":        s.FileSize,
		"codec":            s.Codec,
		"resolution":       s.Resolution,
		"trigger_type":     s.TriggerType,
		"storage_pool_id":  s.StoragePoolID,
		"integrity_status": s.IntegrityStatus,
		"locked":           s.Locked,
		"has_motion":       s.HasMotion,
	}
}

// liveProfile picks the stream profile to view live: the substream (web-friendly,
// usually H.264) when the camera advertises one, else the main profile. The
// substream is preferred for browser live view; main is the recording profile.
func liveProfile(c store.Camera) string {
	for _, p := range c.Profiles {
		if p.Name == "sub" {
			return "sub"
		}
	}
	return "main"
}

// parseOptRFC3339 parses an optional RFC3339 timestamp; an empty value is nil (no
// bound), not an error.
func parseOptRFC3339(v string) (*time.Time, error) {
	if strings.TrimSpace(v) == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return &t, nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// formatSeconds renders a duration (seconds) without a trailing ".000" so the
// playback URL stays clean for whole-second windows.
func formatSeconds(sec float64) string {
	s := strconv.FormatFloat(sec, 'f', -1, 64)
	return s
}
