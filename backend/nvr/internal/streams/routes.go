// Package streams mounts the nvr's internal stream-orchestration HTTP endpoints.
//
// These are INTERNAL, service-to-service routes — called by the Python `vision`
// control-plane (P2-B), NOT by browsers, and never routed through the public
// gateway. They are JWT-gated by the SAME core-minted token the rest of the
// platform uses; a caller must hold the relevant vms.* permission (vision passes
// through the operator's token, or a service token carrying "*"):
//
//	POST   /api/v1/nvr/streams/ensure          {camera_id, rtsp_url, profile} → Stream
//	DELETE /api/v1/nvr/streams/{camera_id}/{profile}                          → 204
//	GET    /api/v1/nvr/streams                                                → [Stream]
//
// Tenant scoping: the path name is cameras/<tenant_id>/<camera_id>/<profile>,
// where tenant_id is taken from the caller's token (a super-admin service token
// with no tenant falls back to "platform"). This keeps one tenant's streams
// namespaced away from another's on the shared MediaMTX node.
package streams

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/neubit/gokernel/auth"
	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/supervisor"
)

// Permissions required by the internal endpoints. A caller holding "*" (a
// service/super-admin token) or the specific grant passes.
const (
	permLiveView  = "vms.live.view"
	permCameraMgr = "vms.camera.manage"
)

// Mount registers the streams sub-router under an already-JWT-gated parent.
func Mount(r chi.Router, sup *supervisor.Supervisor) {
	h := &handler{sup: sup}
	r.Route("/streams", func(sr chi.Router) {
		sr.With(httpx.RequirePermission(permCameraMgr)).Post("/ensure", h.ensure)
		sr.With(httpx.RequirePermission(permCameraMgr)).Delete("/{camera_id}/{profile}", h.drop)
		sr.With(httpx.RequirePermission(permLiveView)).Get("/", h.list)
	})
}

type handler struct {
	sup *supervisor.Supervisor
}

type ensureRequest struct {
	CameraID string `json:"camera_id"`
	RTSPURL  string `json:"rtsp_url"`
	Profile  string `json:"profile"`
}

// ensure assigns a node, provisions the MediaMTX path, and returns the playable
// URLs. Graceful: a bad/unreachable RTSP or a down MediaMTX yields a clean 502
// (never a 500 panic). A path that exists but has no reader yet returns 200 with
// ready:false — the normal on-demand case.
func (h *handler) ensure(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	var req ensureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		kerr.Write(w, kerr.BadRequest("invalid JSON body"))
		return
	}
	req.CameraID = strings.TrimSpace(req.CameraID)
	req.RTSPURL = strings.TrimSpace(req.RTSPURL)
	if req.CameraID == "" || req.RTSPURL == "" {
		kerr.Write(w, kerr.Validation("camera_id and rtsp_url are required"))
		return
	}

	st, err := h.sup.EnsureStream(r.Context(), tenant, req.CameraID, req.Profile, req.RTSPURL)
	if err != nil {
		// MediaMTX/RTSP trouble → a graceful upstream error, not a 500.
		kerr.Write(w, &kerr.APIError{
			Code:    "MEDIA_UPSTREAM",
			Message: "media node could not provision the stream: " + err.Error(),
			Status:  http.StatusBadGateway,
		})
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

// drop deletes the MediaMTX path + shard for (camera_id, profile). Idempotent.
func (h *handler) drop(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	cameraID := chi.URLParam(r, "camera_id")
	profile := chi.URLParam(r, "profile")
	if err := h.sup.DropStream(r.Context(), tenant, cameraID, profile); err != nil {
		kerr.Write(w, kerr.Internal("could not drop stream"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// list returns every active stream (name/node/readers).
func (h *handler) list(w http.ResponseWriter, r *http.Request) {
	items, err := h.sup.ListStreams(r.Context())
	if err != nil {
		kerr.Write(w, kerr.Internal("could not list streams"))
		return
	}
	if items == nil {
		items = []supervisor.Stream{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// tenantOf resolves the tenant id for path namespacing from the caller's token.
// A tenant-scoped operator token yields that tenant; a platform/service token
// (no tenant) falls back to "platform".
func tenantOf(r *http.Request) string {
	if p, ok := httpx.PrincipalFrom(r.Context()); ok && p.TenantID != nil {
		return p.TenantID.String()
	}
	_ = auth.Wildcard // keep the auth dependency explicit
	return "platform"
}
