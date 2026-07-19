// Package mediamtx is the Go client for a MediaMTX media node's control API.
//
// It is the Go port of neubit_v2's app/mediamtx/client.py (MediaMTXClient):
//
//	v2 upsert_path(name, source)        → Client.EnsurePath(ctx, node, name, source, extra)
//	v2 remove_path(name)                → Client.DeletePath(ctx, node, name)
//	v2 list_paths()                     → Client.ListPaths(ctx, node)  (+ PathState)
//	v2 public_hls_url(name)             → HLSURL(node, name)   /<name>/index.m3u8
//	v2 public_webrtc_url(name)          → WHEPURL(node, name)  /<name>/whep
//	v2 path_for_camera(cam, profile)    → PathName(tenant, cam, profile)
//
// Each path's `source` is a camera RTSP URL and MediaMTX pulls it ON DEMAND
// (sourceOnDemand) — the first HLS/WHEP reader triggers the pull, and the idle
// reaper (see supervisor) tears paths down. Every method is graceful on an
// unreachable MediaMTX / RTSP: a down node or camera returns an error the caller
// can surface as ready:false, and never panics.
package mediamtx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Node is the addressing for one MediaMTX instance: the INTERNAL control API URL
// (nvr-only) plus the browser-facing public base URLs returned to callers.
type Node struct {
	ID         string
	APIURL     string // internal control API, e.g. http://mediamtx:9997
	HLSBase    string // browser-facing, e.g. http://localhost:8888
	WebRTCBase string // browser-facing, e.g. http://localhost:8889
	RTSPBase   string // browser-facing, e.g. rtsp://localhost:8554

	// PlaybackAPIURL is the INTERNAL MediaMTX playback server (P4-A, default
	// http://mediamtx:9996) — the nvr queries /list?path= here to enumerate
	// recorded ranges. PlaybackBase is the BROWSER-facing base the /get URL is
	// built from: it points at the Traefik gateway prefix (/media/playback) so
	// recorded-fmp4 playback is token-gated by the same media-auth ForwardAuth as
	// live (P2-C), never the raw playback port.
	PlaybackAPIURL string // internal, e.g. http://mediamtx:9996
	PlaybackBase   string // browser-facing, e.g. http://localhost/media/playback
}

// Client talks to MediaMTX control APIs over HTTP. It is node-agnostic — every
// method takes the target Node — so one client serves a whole shard of nodes.
type Client struct {
	http *http.Client
}

// New builds a Client with a bounded per-request timeout (matches v2's httpx
// timeout=10). The timeout keeps a hung MediaMTX from stalling nvr requests.
func New() *Client {
	return &Client{http: &http.Client{Timeout: 10 * time.Second}}
}

// PathName is the MediaMTX path naming convention, matching v2's
// path_for_camera but tenant-scoped: cameras/<tenant_id>/<camera_id>/<profile>.
func PathName(tenantID, cameraID, profile string) string {
	if profile == "" {
		profile = "main"
	}
	return fmt.Sprintf("cameras/%s/%s/%s", tenantID, cameraID, profile)
}

// HLSURL builds the browser-facing HLS URL: <hls-base>/<name>/index.m3u8
// (v2 public_hls_url).
func HLSURL(node Node, name string) string {
	return strings.TrimRight(node.HLSBase, "/") + "/" + name + "/index.m3u8"
}

// WHEPURL builds the browser-facing WebRTC/WHEP URL: <webrtc-base>/<name>/whep
// (v2 public_webrtc_url).
func WHEPURL(node Node, name string) string {
	return strings.TrimRight(node.WebRTCBase, "/") + "/" + name + "/whep"
}

// RTSPURL builds the browser-/service-facing RTSP URL: <rtsp-base>/<name>
// (v2 public_rtsp_url).
func RTSPURL(node Node, name string) string {
	return strings.TrimRight(node.RTSPBase, "/") + "/" + name
}

// pathConfig is the MediaMTX path config body. sourceOnDemand pulls RTSP lazily
// on the first reader; the record* fields (P3-A) drive MediaMTX native recording.
type pathConfig struct {
	Source                     string `json:"source"`
	SourceOnDemand             bool   `json:"sourceOnDemand"`
	SourceOnDemandStartTimeout string `json:"sourceOnDemandStartTimeout,omitempty"`
	SourceOnDemandCloseAfter   string `json:"sourceOnDemandCloseAfter,omitempty"`
	RTSPTransport              string `json:"rtspTransport,omitempty"`
}

// recordConfig is the MediaMTX record patch body (P3-A). When record is on, a
// path with a live source writes fmp4 segments to recordPath. recordDeleteAfter
// is pinned to "0s" (never auto-delete) — the nvr owns retention (P3-B), not
// MediaMTX. Recording a source-on-demand path also needs the source pulling, so
// SetRecord flips sourceOnDemand OFF while recording (MediaMTX then keeps the
// source connected continuously, which is what continuous recording requires).
type recordConfig struct {
	Record                bool   `json:"record"`
	RecordPath            string `json:"recordPath,omitempty"`
	RecordFormat          string `json:"recordFormat,omitempty"`
	RecordSegmentDuration string `json:"recordSegmentDuration,omitempty"`
	RecordDeleteAfter     string `json:"recordDeleteAfter,omitempty"`
	SourceOnDemand        bool   `json:"sourceOnDemand"`
}

// RecordOpts tunes SetRecord. RecordPath is the MediaMTX record template (with
// %path/%Y-%m-%d_%H-%M-%S-%f placeholders); SegmentDuration is e.g. "60s". Empty
// fields fall back to the defaults below.
type RecordOpts struct {
	RecordPath      string
	SegmentDuration string
}

// EnsurePath idempotently provisions a path whose `source` is the camera RTSP
// URL — the Go port of v2 upsert_path: POST /v3/config/paths/add/<name>, and on
// a 400/409 conflict PATCH /v3/config/paths/patch/<name>. `extra` lets callers
// override defaults (e.g. rtspTransport). Graceful: any transport error to a
// down MediaMTX is returned, not panicked.
func (c *Client) EnsurePath(ctx context.Context, node Node, name, source string, extra map[string]string) error {
	cfg := pathConfig{
		Source:                     source,
		SourceOnDemand:             true,
		SourceOnDemandStartTimeout: "20s",
		SourceOnDemandCloseAfter:   "120s",
		RTSPTransport:              "tcp",
	}
	if v, ok := extra["rtspTransport"]; ok && v != "" {
		cfg.RTSPTransport = v
	}
	body, _ := json.Marshal(cfg)

	// Try add; on conflict (already exists) patch instead — same flow as v2.
	status, _, err := c.do(ctx, node, http.MethodPost, "/v3/config/paths/add/"+name, body)
	if err != nil {
		return fmt.Errorf("mediamtx add path %q: %w", name, err)
	}
	if status == http.StatusOK || status == http.StatusCreated {
		return nil
	}
	if status == http.StatusBadRequest || status == http.StatusConflict {
		pstatus, pbody, perr := c.do(ctx, node, http.MethodPatch, "/v3/config/paths/patch/"+name, body)
		if perr != nil {
			return fmt.Errorf("mediamtx patch path %q: %w", name, perr)
		}
		if pstatus != http.StatusOK && pstatus != http.StatusCreated {
			return fmt.Errorf("mediamtx patch path %q: status %d: %s", name, pstatus, string(pbody))
		}
		return nil
	}
	return fmt.Errorf("mediamtx add path %q: unexpected status %d", name, status)
}

// SetRecord toggles MediaMTX native recording on an EXISTING path (P3-A). It
// PATCHes the path's record flag (+ recordPath/format/segment on enable) via the
// control API. The path must already exist (the recording supervisor ensures the
// live path first). recordDeleteAfter is pinned to "0s" so MediaMTX never prunes
// segments — the nvr owns retention (P3-B).
//
// Enabling recording flips sourceOnDemand OFF: a continuous recording needs the
// source connected even with no live viewer, whereas on-demand only pulls for a
// reader. Disabling restores sourceOnDemand so an unwatched path idles again.
//
// Graceful: an unreachable MediaMTX returns an error the caller surfaces cleanly.
func (c *Client) SetRecord(ctx context.Context, node Node, name string, on bool, opts RecordOpts) error {
	cfg := recordConfig{
		Record:         on,
		SourceOnDemand: !on, // record ⇒ keep source hot; stop ⇒ back to on-demand
	}
	if on {
		cfg.RecordPath = opts.RecordPath
		if cfg.RecordPath == "" {
			cfg.RecordPath = "/recordings/%path/%Y-%m-%d/%H-%M-%S-%f"
		}
		cfg.RecordFormat = "fmp4"
		cfg.RecordSegmentDuration = opts.SegmentDuration
		if cfg.RecordSegmentDuration == "" {
			cfg.RecordSegmentDuration = "60s"
		}
		cfg.RecordDeleteAfter = "0s" // nvr owns retention, not MediaMTX
	}
	body, _ := json.Marshal(cfg)
	status, rbody, err := c.do(ctx, node, http.MethodPatch, "/v3/config/paths/patch/"+name, body)
	if err != nil {
		return fmt.Errorf("mediamtx set record %q: %w", name, err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return fmt.Errorf("mediamtx set record %q: status %d: %s", name, status, string(rbody))
	}
	return nil
}

// recordPathPatch is a minimal PATCH body carrying ONLY recordPath. It deliberately
// omits source/sourceOnDemand so patching an EXISTING path (a live RTSP path, or a
// leftover) rebinds its record location WITHOUT clobbering its source — patching
// source:publisher onto a live RTSP path corrupts it (MediaMTX then rejects the next
// live re-provision with "'sourceOnDemand' is useless when source is 'publisher'").
type recordPathPatch struct {
	RecordPath string `json:"recordPath"`
}

// playbackAddConfig is the ADD body for the case where NO path config exists yet
// (the on-demand live path was reaped after recording stopped, leaving only the
// static regex). A bare recordPath ADD is rejected — MediaMTX requires a source — so
// this uses source:publisher (a passive, never-pulls path). A later live ADD→PATCH
// with a full RTSP config overrides publisher cleanly, so this does not block live.
type playbackAddConfig struct {
	Source         string `json:"source"`
	SourceOnDemand bool   `json:"sourceOnDemand"`
	Record         bool   `json:"record"`
	RecordPath     string `json:"recordPath"`
}

// pathRecordPath reads the recordPath currently configured for a path via
// /v3/config/paths/get/<name>. found=false (nil err) when the path is not
// configured. Used to skip a redundant recordPath PATCH (which would trigger a
// MediaMTX config reload) when the binding is already correct.
func (c *Client) pathRecordPath(ctx context.Context, node Node, name string) (string, bool, error) {
	status, body, err := c.do(ctx, node, http.MethodGet, "/v3/config/paths/get/"+name, nil)
	if err != nil {
		return "", false, err
	}
	if status == http.StatusNotFound {
		return "", false, nil
	}
	if status != http.StatusOK {
		return "", false, fmt.Errorf("mediamtx path config %q: status %d", name, status)
	}
	var cfg struct {
		RecordPath string `json:"recordPath"`
	}
	if err := json.Unmarshal(body, &cfg); err != nil {
		return "", false, fmt.Errorf("mediamtx path config %q: decode: %w", name, err)
	}
	return cfg.RecordPath, true, nil
}

// EnsurePlaybackPath makes the MediaMTX playback server (:9996) resolve `name`'s
// recorded segments from `recordPath` (the camera's per-pool template, e.g.
// `/recordings/poolB/%path/%Y-%m-%d_%H-%M-%S-%f`). This is the multi-pool playback
// fix: the playback server derives a path's segment directory from the recordPath of
// the path config matching the requested `?path=`. Without an explicit config the only
// match is the static regex (root `/recordings/`), so footage on a non-default pool is
// invisible. Binding the pool's recordPath makes /list + /get resolve the correct
// drive — for ANY operator pool at ANY absolute path.
//
// Strategy (surgical — must NOT regress live streaming):
//   - PATCH recordPath ONLY. If the path exists (live RTSP path, or a leftover), this
//     rebinds its record location while preserving its source, so a subsequent live
//     re-provision is unaffected.
//   - If the path does not exist (404), ADD a passive publisher path carrying the
//     recordPath. A later live provision overrides publisher via its own ADD→PATCH.
//
// Graceful: an unreachable MediaMTX returns an error the caller surfaces as 502.
func (c *Client) EnsurePlaybackPath(ctx context.Context, node Node, name, recordPath string) error {
	// Skip the write entirely when the path already resolves to this recordPath. Even a
	// no-op PATCH makes MediaMTX RELOAD its config, which briefly drops the playback
	// server (:9996) and 502s an immediately-following /list — the "first playback of a
	// camera 502s, retry works" bug. The common case (an actively-recording camera)
	// already carries the correct pool recordPath from SetRecord, so this check avoids
	// the reload and the 502 outright.
	if cur, found, gerr := c.pathRecordPath(ctx, node, name); gerr == nil && found && cur == recordPath {
		return nil
	}
	patch, _ := json.Marshal(recordPathPatch{RecordPath: recordPath})
	status, pbody, err := c.do(ctx, node, http.MethodPatch, "/v3/config/paths/patch/"+name, patch)
	if err != nil {
		return fmt.Errorf("mediamtx bind playback recordPath %q: %w", name, err)
	}
	if status == http.StatusOK || status == http.StatusCreated {
		return nil
	}
	if status == http.StatusNotFound {
		// No path config yet — add a passive publisher path bound to the recordPath.
		add, _ := json.Marshal(playbackAddConfig{
			Source:         "publisher",
			SourceOnDemand: false,
			Record:         false,
			RecordPath:     recordPath,
		})
		astatus, abody, aerr := c.do(ctx, node, http.MethodPost, "/v3/config/paths/add/"+name, add)
		if aerr != nil {
			return fmt.Errorf("mediamtx add playback path %q: %w", name, aerr)
		}
		if astatus != http.StatusOK && astatus != http.StatusCreated {
			return fmt.Errorf("mediamtx add playback path %q: status %d: %s", name, astatus, string(abody))
		}
		return nil
	}
	return fmt.Errorf("mediamtx bind playback recordPath %q: status %d: %s", name, status, string(pbody))
}

// RecordingSegment is one finalized recording segment as reported by MediaMTX's
// /v3/recordings/get/<name> API. `Start` is the segment's start time (RFC3339);
// MediaMTX does not report end/size in this API, so the segment tracker derives
// those from the filesystem/next-segment boundary.
type RecordingSegment struct {
	Start string `json:"start"`
}

// RecordingEntry is one path's recording listing (name + its segments).
type RecordingEntry struct {
	Name     string             `json:"name"`
	Segments []RecordingSegment `json:"segments"`
}

type recordingsListResponse struct {
	Items []RecordingEntry `json:"items"`
}

// ListRecordings returns every path's recorded-segment index on the node via
// /v3/recordings/list. A node without the recordings API (or unreachable) yields
// an error the caller treats as "nothing new this tick" (graceful).
func (c *Client) ListRecordings(ctx context.Context, node Node) ([]RecordingEntry, error) {
	status, body, err := c.do(ctx, node, http.MethodGet, "/v3/recordings/list", nil)
	if err != nil {
		return nil, fmt.Errorf("mediamtx list recordings: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("mediamtx list recordings: status %d", status)
	}
	var out recordingsListResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("mediamtx list recordings: decode: %w", err)
	}
	return out.Items, nil
}

// ── Playback server (P4-A) ──────────────────────────────────────────────────
//
// MediaMTX ships a SEPARATE playback server (enabled with `playback: yes`, its own
// port, default :9996) that serves the recorded fmp4 segments of a path as a
// seekable stream:
//
//	GET /list?path=<name>                              → [{start, duration, url}]
//	GET /get?path=<name>&start=<ISO>&duration=<sec>&format=fmp4 → the recorded stream
//
// The nvr queries /list on the INTERNAL playback port to enumerate recorded ranges
// for a camera+window, and builds the browser-facing /get URL through the Traefik
// GATEWAY prefix (PlaybackBase → /media/playback) so playback is token-gated by the
// same media-auth ForwardAuth as live. It never re-implements a segment player.

// PlaybackRange is one contiguous recorded time-range MediaMTX reports for a path
// via /list: its Start (RFC3339) and Duration (seconds). A gap between recordings
// starts a new range, so the ranges are the recorded COVERAGE of the path.
type PlaybackRange struct {
	Start    string  `json:"start"`
	Duration float64 `json:"duration"`
}

// PlaybackList queries the MediaMTX playback server's /list?path=<name> for the
// recorded ranges of a path, optionally filtered to overlap [from,to] (zero-value
// bounds disable that side of the filter). Graceful: an unreachable playback server
// / a path with no recordings yields (nil, err) or an empty slice, never a panic —
// the caller surfaces an empty timeline / a clean 502.
func (c *Client) PlaybackList(ctx context.Context, node Node, name string, from, to time.Time) ([]PlaybackRange, error) {
	base := strings.TrimRight(node.PlaybackAPIURL, "/")
	if base == "" {
		return nil, fmt.Errorf("mediamtx playback: no playback API url on node %q", node.ID)
	}
	target := base + "/list?path=" + url.QueryEscape(name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mediamtx playback list %q: %w", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// No recordings for this path yet — an empty timeline, not an error.
		return []PlaybackRange{}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mediamtx playback list %q: status %d", name, resp.StatusCode)
	}
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	var ranges []PlaybackRange
	if err := json.Unmarshal(buf.Bytes(), &ranges); err != nil {
		return nil, fmt.Errorf("mediamtx playback list %q: decode: %w", name, err)
	}
	if from.IsZero() && to.IsZero() {
		return ranges, nil
	}
	return filterRanges(ranges, from, to), nil
}

// filterRanges keeps ranges that OVERLAP [from,to] (either bound may be zero to
// disable that side). A range [rs, rs+dur) overlaps when rs < to and rs+dur > from.
func filterRanges(ranges []PlaybackRange, from, to time.Time) []PlaybackRange {
	out := make([]PlaybackRange, 0, len(ranges))
	for _, r := range ranges {
		rs, err := time.Parse(time.RFC3339Nano, r.Start)
		if err != nil {
			rs, err = time.Parse(time.RFC3339, r.Start)
			if err != nil {
				continue // unparseable start — drop it rather than mis-filter
			}
		}
		re := rs.Add(time.Duration(r.Duration * float64(time.Second)))
		if !to.IsZero() && !rs.Before(to) {
			continue // range starts at/after the window end
		}
		if !from.IsZero() && !re.After(from) {
			continue // range ends at/before the window start
		}
		out = append(out, r)
	}
	return out
}

// PlaybackURL builds the BROWSER-facing recorded-playback /get URL through the
// gateway prefix (node.PlaybackBase → /media/playback), so the recorded fmp4 is
// served token-gated by the media-auth ForwardAuth. startISO is the RFC3339 window
// start; durationSec its length. The token is appended by the caller (vision) — the
// same ?token= pattern live uses.
func PlaybackURL(node Node, name, startISO string, durationSec float64) string {
	base := strings.TrimRight(node.PlaybackBase, "/")
	q := url.Values{}
	q.Set("path", name)
	q.Set("start", startISO)
	q.Set("duration", strconv.FormatFloat(durationSec, 'f', -1, 64))
	q.Set("format", "fmp4")
	return base + "/get?" + q.Encode()
}

// DeletePath removes a path — the Go port of v2 remove_path. A 404 (already
// gone) is treated as success so delete is idempotent.
func (c *Client) DeletePath(ctx context.Context, node Node, name string) error {
	status, body, err := c.do(ctx, node, http.MethodDelete, "/v3/config/paths/delete/"+name, nil)
	if err != nil {
		return fmt.Errorf("mediamtx delete path %q: %w", name, err)
	}
	if status == http.StatusOK || status == http.StatusNotFound {
		return nil
	}
	return fmt.Errorf("mediamtx delete path %q: status %d: %s", name, status, string(body))
}

// PathInfo is a runtime view of one MediaMTX path from /v3/paths/list.
type PathInfo struct {
	Name    string `json:"name"`
	Ready   bool   `json:"ready"`
	Readers []struct {
		Type string `json:"type"`
	} `json:"readers"`
}

// ReaderCount returns the number of active readers on the path.
func (p PathInfo) ReaderCount() int { return len(p.Readers) }

type pathsListResponse struct {
	Items []PathInfo `json:"items"`
}

// ListPaths returns the runtime state of every path on the node (v2 list_paths,
// but richer — full PathInfo, not just names). A down node yields an error.
func (c *Client) ListPaths(ctx context.Context, node Node) ([]PathInfo, error) {
	status, body, err := c.do(ctx, node, http.MethodGet, "/v3/paths/list", nil)
	if err != nil {
		return nil, fmt.Errorf("mediamtx list paths: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("mediamtx list paths: status %d", status)
	}
	var out pathsListResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("mediamtx list paths: decode: %w", err)
	}
	return out.Items, nil
}

// PathState fetches the runtime state of a single path via
// /v3/paths/get/<name>. Returns (info, found, err): found=false (nil err) when
// the path is not (yet) instanced — the normal case for an on-demand path with
// no reader, so callers report ready:false rather than an error.
func (c *Client) PathState(ctx context.Context, node Node, name string) (PathInfo, bool, error) {
	status, body, err := c.do(ctx, node, http.MethodGet, "/v3/paths/get/"+name, nil)
	if err != nil {
		return PathInfo{}, false, fmt.Errorf("mediamtx path state %q: %w", name, err)
	}
	if status == http.StatusNotFound {
		return PathInfo{}, false, nil
	}
	if status != http.StatusOK {
		return PathInfo{}, false, fmt.Errorf("mediamtx path state %q: status %d", name, status)
	}
	var info PathInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return PathInfo{}, false, fmt.Errorf("mediamtx path state %q: decode: %w", name, err)
	}
	return info, true, nil
}

// PathConfigured reports whether a path exists in the MediaMTX CONFIG via
// /v3/config/paths/get/<name>. This is the config-level existence check (distinct
// from PathState's runtime /v3/paths/get) — SetRecord patches the config path, so
// this is what tells the reconcile loop whether it must (re)add the path before
// setting record. ok=false (nil err) when the path is not configured; err only on
// a transport/status failure so the caller can decide conservatively.
func (c *Client) PathConfigured(ctx context.Context, node Node, name string) (bool, error) {
	status, _, err := c.do(ctx, node, http.MethodGet, "/v3/config/paths/get/"+name, nil)
	if err != nil {
		return false, fmt.Errorf("mediamtx path config %q: %w", name, err)
	}
	if status == http.StatusNotFound {
		return false, nil
	}
	if status != http.StatusOK {
		return false, fmt.Errorf("mediamtx path config %q: status %d", name, status)
	}
	return true, nil
}

// Healthy probes the node's control API (config global) — used by the supervisor
// to mark a node up/down.
func (c *Client) Healthy(ctx context.Context, node Node) bool {
	status, _, err := c.do(ctx, node, http.MethodGet, "/v3/config/global/get", nil)
	return err == nil && status == http.StatusOK
}

// do performs one control-API request and returns (status, body, transportErr).
// A non-2xx status is NOT an error here — callers decide (add-vs-patch, 404-ok).
func (c *Client) do(ctx context.Context, node Node, method, apiPath string, body []byte) (int, []byte, error) {
	target := strings.TrimRight(node.APIURL, "/") + apiPath
	var rdr *bytes.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rdr)
	if err != nil {
		return 0, nil, err
	}
	// MediaMTX path names contain slashes (cameras/<tenant>/<cam>/<profile>).
	// Go path-cleans req.URL.Path (collapsing/resolving segments); pin RawPath to
	// the escaped form so the name reaches MediaMTX exactly as built.
	req.URL.RawPath = req.URL.EscapedPath()
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes(), nil
}
