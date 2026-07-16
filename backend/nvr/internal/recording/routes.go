// Package recording — internal HTTP endpoints (service-to-service, JWT-gated).
//
// Called by the Python `vision` control-plane (P3-A), NOT by browsers, and never
// routed through the public gateway. Gated by the SAME core-minted token + the
// vms.* permission catalog (a service token carrying "*" also passes):
//
//	POST /api/v1/nvr/recording/{camera_id}/{profile}/start  {rtsp_url, trigger?} → Active
//	POST /api/v1/nvr/recording/{camera_id}/{profile}/stop                        → 204
//	GET  /api/v1/nvr/recording/status                                            → [Active]
//
// Tenant scoping mirrors the streams routes: the path name is
// cameras/<tenant>/<camera>/<profile>, tenant from the caller's token (a platform
// service token with no tenant falls back to "platform").
package recording

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"
)

// Permissions the recording endpoints gate on. control = writes (start/stop),
// playback.view = the read (status). "*" (service/super-admin) passes either.
const (
	permRecordingControl = "vms.recording.control"
	permPlaybackView     = "vms.playback.view"
)

// Mount registers the recording sub-router under an already-JWT-gated parent.
func Mount(r chi.Router, sup *Supervisor) {
	h := &handler{sup: sup}
	r.Route("/recording", func(rr chi.Router) {
		rr.With(httpx.RequirePermission(permRecordingControl)).
			Post("/{camera_id}/{profile}/start", h.start)
		rr.With(httpx.RequirePermission(permRecordingControl)).
			Post("/{camera_id}/{profile}/stop", h.stop)
		rr.With(httpx.RequirePermission(permPlaybackView)).
			Get("/status", h.status)
	})
}

type handler struct {
	sup *Supervisor
}

type startRequest struct {
	RTSPURL string `json:"rtsp_url"`
	Trigger string `json:"trigger"`
	// Redundant enables failover recording (P6-A): record on a primary + secondary
	// node so a single node loss keeps footage. Optional; defaults false.
	Redundant bool `json:"redundant"`
	// EventClip + buffers wire the P5 motion/event entry point (optional).
	EventClip bool `json:"event_clip"`
	PreSec    int  `json:"pre_seconds"`
	PostSec   int  `json:"post_seconds"`
	// Audio (G6) — the control-plane's intent to RETAIN the audio track in the
	// recording (the camera has an audio track AND the operator enabled it). MediaMTX
	// native recording records EVERY track the source publishes, so audio=true is the
	// no-op "keep whatever the source has" path; audio=false would require sourcing a
	// video-only stream variant / an ffmpeg audio-drop — # LIVE-VALIDATE per brand.
	// Accepted here so the contract is explicit; carried as recording intent (no schema
	// change). Optional; defaults false.
	Audio bool `json:"audio"`
	// RecordDir overrides the recordings root for THIS camera (per-camera storage
	// pool — enterprise VMS). Empty = the default recordings volume.
	RecordDir string `json:"record_dir"`
}

// start turns recording on for (camera, profile). Graceful: a bad/unreachable
// RTSP or down MediaMTX yields a clean 502, never a 500.
func (h *handler) start(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	cameraID := chi.URLParam(r, "camera_id")
	profile := chi.URLParam(r, "profile")

	var req startRequest
	// Body is optional for a re-start of an already-known target, but rtsp_url is
	// needed to (re)provision the path — require it (vision always sends it).
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	req.RTSPURL = strings.TrimSpace(req.RTSPURL)
	if req.RTSPURL == "" {
		kerr.Write(w, kerr.Validation("rtsp_url is required to start recording"))
		return
	}

	// G6 audio intent: MediaMTX records all source tracks, so audio=true is the
	// keep-as-is path. audio=false (video-only) needs a source variant / audio-drop —
	// logged as intent here (# LIVE-VALIDATE per brand); does not change the record flag.
	if !req.Audio {
		log.Printf("recording %s/%s: audio track NOT requested (video-only intent; MediaMTX records source tracks as-is — audio-drop is LIVE-VALIDATE)", cameraID, profile)
	}

	var (
		act Active
		err error
	)
	if req.EventClip {
		act, err = h.sup.StartEventClip(
			r.Context(), tenant, cameraID, profile, req.RTSPURL, req.Trigger, req.PreSec, req.PostSec,
		)
	} else {
		act, err = h.sup.StartRecording(
			r.Context(), tenant, cameraID, profile, req.RTSPURL, req.Trigger, req.Redundant, req.RecordDir,
		)
	}
	if err != nil {
		kerr.Write(w, &kerr.APIError{
			Code:    "MEDIA_UPSTREAM",
			Message: "could not start recording: " + err.Error(),
			Status:  http.StatusBadGateway,
		})
		return
	}
	httpx.JSON(w, http.StatusOK, act)
}

// stop turns recording off. Idempotent — a missing target is not an error.
func (h *handler) stop(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	cameraID := chi.URLParam(r, "camera_id")
	profile := chi.URLParam(r, "profile")
	if err := h.sup.StopRecording(r.Context(), tenant, cameraID, profile); err != nil {
		kerr.Write(w, kerr.Internal("could not stop recording"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// status returns every active recording target.
func (h *handler) status(w http.ResponseWriter, r *http.Request) {
	items, err := h.sup.ListActive(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("could not list recordings"))
		return
	}
	if items == nil {
		items = []Active{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// tenantOf resolves the tenant id for path namespacing from the caller's token —
// same convention as the streams routes.
func tenantOf(r *http.Request) string {
	if p, ok := httpx.PrincipalFrom(r.Context()); ok && p.TenantID != nil {
		return p.TenantID.String()
	}
	return "platform"
}
