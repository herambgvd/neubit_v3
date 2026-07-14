// Package anr — internal HTTP endpoints for ANR-job visibility (service-to-service,
// JWT-gated). Called by the Python `vision` control-plane / an operator UI, NOT by
// browsers directly, gated by the vms.* permission catalog (a service token
// carrying "*" passes):
//
//	GET  /api/v1/nvr/anr/jobs?camera_id=&limit=            → { items: [Job] }
//	POST /api/v1/nvr/anr/detect/{camera_id}/{profile}      → { detected, job_id, gap }
//
// The detect endpoint force-runs gap detection for a camera (the reconnect signal
// vision can push instead of waiting for the sweep) and opens a job if a gap is
// found — the manual counterpart of the background sweep.
package anr

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"
)

// Permissions. Reads gate on playback.view (ANR is a recording-coverage concern);
// the detect trigger gates on recording.control (it can open a backfill job).
const (
	permPlaybackView     = "vms.playback.view"
	permRecordingControl = "vms.recording.control"
)

// Mount registers the anr sub-router under an already-JWT-gated parent.
func Mount(r chi.Router, e *Engine) {
	h := &handler{e: e}
	r.Route("/anr", func(ar chi.Router) {
		ar.With(httpx.RequirePermission(permPlaybackView)).Get("/jobs", h.jobs)
		ar.With(httpx.RequirePermission(permRecordingControl)).
			Post("/detect/{camera_id}/{profile}", h.detect)
	})
}

type handler struct {
	e *Engine
}

// jobs lists recent ANR jobs for the caller's tenant (optionally per camera).
func (h *handler) jobs(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	camera := r.URL.Query().Get("camera_id")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := h.e.ListJobs(r.Context(), tenant, camera, limit)
	if err != nil {
		kerr.Write(w, kerr.Internal("could not list anr jobs"))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// detect force-runs gap detection for (camera, profile) and opens a job if a gap
// is present. The record_path for the backfill is read from the camera's active
// recording target; an absent target still detects but can't publish a usable
// backfill path (the response reports detected=true, job_id set, and the fulfiller
// falls back to a default layout).
func (h *handler) detect(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	camera := chi.URLParam(r, "camera_id")
	profile := chi.URLParam(r, "profile")
	if profile == "" {
		profile = "main"
	}

	gap, ok, err := h.e.DetectGap(r.Context(), tenant, camera, profile)
	if err != nil {
		kerr.Write(w, kerr.Internal("gap detection failed"))
		return
	}
	resp := map[string]any{"detected": ok}
	if !ok {
		httpx.JSON(w, http.StatusOK, resp)
		return
	}

	recPath := h.e.recordPathFor(r.Context(), tenant, camera, profile)
	jobID, err := h.e.OpenJob(r.Context(), tenant, camera, profile, gap.From, gap.To, recPath)
	if err != nil {
		kerr.Write(w, kerr.Internal("could not open anr job"))
		return
	}
	resp["job_id"] = jobID
	resp["gap"] = map[string]string{
		"from": gap.From.UTC().Format(time.RFC3339Nano),
		"to":   gap.To.UTC().Format(time.RFC3339Nano),
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// tenantOf resolves the tenant id from the caller's token — same convention as the
// streams/recording/playback routes.
func tenantOf(r *http.Request) string {
	if p, ok := httpx.PrincipalFrom(r.Context()); ok && p.TenantID != nil {
		return p.TenantID.String()
	}
	return "platform"
}
