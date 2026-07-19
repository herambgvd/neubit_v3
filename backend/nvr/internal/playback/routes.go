// Package playback mounts the nvr's internal recorded-playback HTTP endpoint (P4-A).
//
// This is an INTERNAL, service-to-service route — called by the Python `vision`
// control-plane (which issues the recorded PlaybackSession), NOT by browsers, and
// never routed through the public gateway. It is JWT-gated by the SAME core-minted
// token + the vms.* permission catalog (a service token carrying "*" passes):
//
//	GET /api/v1/nvr/playback/{camera_id}/{profile}?from=&to=
//	    → { ranges: [{start, duration}], playback_url, node, name }
//
// It resolves the camera's MediaMTX node (via the stream-supervisor's node
// assignment — NVR-affinity keeps a camera on the node it recorded on), queries the
// MediaMTX playback server's /list for the recorded ranges overlapping [from,to],
// and builds the browser-facing /get URL through the gateway prefix (token-gated by
// the media-auth ForwardAuth, appended by vision).
//
// Tenant scoping mirrors the streams/recording routes: the path name is
// cameras/<tenant>/<camera>/<profile>, tenant from the caller's token (a platform
// service token with no tenant falls back to "platform").
//
// Graceful: no recordings → 200 with an empty ranges list (never 500); an
// unreachable MediaMTX playback server → a clean 502.
package playback

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/mediamtx"
	"github.com/neubit/nvr/internal/supervisor"
)

// permPlaybackView gates the recorded-playback read. "*" (service/super-admin)
// also passes.
const permPlaybackView = "vms.playback.view"

// Mount registers the playback sub-router under an already-JWT-gated parent.
func Mount(r chi.Router, sup *supervisor.Supervisor, mtx *mediamtx.Client) {
	h := &handler{sup: sup, mtx: mtx}
	r.Route("/playback", func(pr chi.Router) {
		pr.With(httpx.RequirePermission(permPlaybackView)).
			Get("/{camera_id}/{profile}", h.list)
	})
}

type handler struct {
	sup *supervisor.Supervisor
	mtx *mediamtx.Client
}

// listResponse is the internal contract vision consumes: the recorded ranges in the
// window, the browser-facing /get URL (WITHOUT a token — vision appends it), the
// node and the MediaMTX path name.
type listResponse struct {
	Ranges      []mediamtx.PlaybackRange `json:"ranges"`
	PlaybackURL string                   `json:"playback_url"`
	Node        string                   `json:"node"`
	Name        string                   `json:"name"`
}

// list enumerates the recorded ranges for (camera, profile) overlapping the
// [from,to] window and returns the playback /get URL. Graceful throughout.
func (h *handler) list(w http.ResponseWriter, r *http.Request) {
	tenant := tenantOf(r)
	cameraID := chi.URLParam(r, "camera_id")
	profile := chi.URLParam(r, "profile")
	if profile == "" {
		profile = "main"
	}

	from, err := parseTime(r.URL.Query().Get("from"))
	if err != nil {
		kerr.Write(w, kerr.Validation("invalid 'from' — expected RFC3339"))
		return
	}
	to, err := parseTime(r.URL.Query().Get("to"))
	if err != nil {
		kerr.Write(w, kerr.Validation("invalid 'to' — expected RFC3339"))
		return
	}

	// Resolve the camera's node (NVR-affinity: a recorded camera keeps its node).
	node, err := h.sup.Assign(r.Context(), tenant, cameraID, profile)
	if err != nil {
		// No media node registered — a clean 502 (nothing can serve playback).
		kerr.Write(w, &kerr.APIError{
			Code:    "MEDIA_UPSTREAM",
			Message: "no media node available for playback: " + err.Error(),
			Status:  http.StatusBadGateway,
		})
		return
	}
	name := mediamtx.PathName(tenant, cameraID, profile)

	// Multi-pool playback: footage may live on a NON-default storage pool (a
	// per-camera RAID drive). The MediaMTX playback server resolves a path's
	// segments from the recordPath of the path config matching `?path=` — by
	// default only the static regex (root `/recordings/`) matches, so non-default
	// pool footage is invisible. If this camera has a recording target with a
	// pool-baked recordPath, (re)assert an explicit path config carrying that
	// recordPath so /list + /get resolve the correct drive. No target (default
	// pool, or never recorded) → leave the default root in place. Best-effort: a
	// patch failure is logged, not fatal — playback still tries the default root.
	if recPath, rerr := h.sup.RecordPathFor(r.Context(), tenant, cameraID, profile); rerr == nil && recPath != "" {
		if perr := h.mtx.EnsurePlaybackPath(r.Context(), node, name, recPath); perr != nil {
			// Non-fatal: fall through to the default-root resolution below.
			_ = perr
		}
	}

	// Deliberately DO NOT call MediaMTX's playback /list here. That endpoint opens EVERY
	// segment in the camera's recordPath dir to compute the full-history timeline, which
	// crashes/resets the whole MediaMTX process on a 24/7 camera's thousands-of-files dir
	// (3k+ after two days, ~86k over 30-day retention) — taking every live stream down
	// with it. That was the persistent playback 502. /list is NOT needed to PLAY: the
	// caller passes an explicit [from,to] window that window() turns into the /get URL,
	// and the scrub-bar coverage is served from the recordings DB (vision timeline), not
	// from here. Return empty ranges; footage streams over the windowed /get path, which
	// only touches the segments inside the requested window.
	ranges := []mediamtx.PlaybackRange{}

	// The /get URL plays the window [from, from+duration). When the caller gave an
	// explicit window, use it; otherwise span the recorded ranges we found. With no
	// recordings there is nothing to build — return an empty URL (vision → 404/empty).
	startISO, durationSec, ok := window(from, to, ranges)
	resp := listResponse{Ranges: ranges, Node: node.ID, Name: name}
	if ok {
		resp.PlaybackURL = mediamtx.PlaybackURL(node, name, startISO, durationSec)
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// window resolves the (start, duration) the /get URL should serve. Preference:
//  1. an explicit [from,to] window (the operator scrubbed to a range);
//  2. otherwise span from the first recorded range's start to the last range's end.
//
// Returns ok=false when there is nothing to serve (no window + no recordings).
func window(from, to time.Time, ranges []mediamtx.PlaybackRange) (string, float64, bool) {
	if !from.IsZero() && !to.IsZero() && to.After(from) {
		return from.UTC().Format(time.RFC3339Nano), to.Sub(from).Seconds(), true
	}
	if len(ranges) == 0 {
		return "", 0, false
	}
	// Span the recorded coverage. Ranges come back start-ordered from MediaMTX.
	first := ranges[0]
	last := ranges[len(ranges)-1]
	start, err := parseRFC3339(first.Start)
	if err != nil {
		return "", 0, false
	}
	lastStart, err := parseRFC3339(last.Start)
	if err != nil {
		return "", 0, false
	}
	end := lastStart.Add(time.Duration(last.Duration * float64(time.Second)))
	// Clamp to an explicit one-sided bound if present.
	if !from.IsZero() && from.After(start) {
		start = from
	}
	if !to.IsZero() && to.Before(end) {
		end = to
	}
	dur := end.Sub(start).Seconds()
	if dur <= 0 {
		return "", 0, false
	}
	return start.UTC().Format(time.RFC3339Nano), dur, true
}

// parseTime parses an optional RFC3339 query param; an empty value is the zero time
// (no bound), not an error.
func parseTime(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	return parseRFC3339(v)
}

func parseRFC3339(v string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, v)
}

// tenantOf resolves the tenant id for path namespacing from the caller's token —
// same convention as the streams/recording routes.
func tenantOf(r *http.Request) string {
	if p, ok := httpx.PrincipalFrom(r.Context()); ok && p.TenantID != nil {
		return p.TenantID.String()
	}
	return "platform"
}
