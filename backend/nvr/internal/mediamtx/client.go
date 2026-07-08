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
// on the first reader; record wiring lands in P3.
type pathConfig struct {
	Source                     string `json:"source"`
	SourceOnDemand             bool   `json:"sourceOnDemand"`
	SourceOnDemandStartTimeout string `json:"sourceOnDemandStartTimeout,omitempty"`
	SourceOnDemandCloseAfter   string `json:"sourceOnDemandCloseAfter,omitempty"`
	RTSPTransport              string `json:"rtspTransport,omitempty"`
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
