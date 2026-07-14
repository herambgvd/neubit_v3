// Package supervisor is the nvr stream-supervisor: it owns the MediaMTX
// media-node registry, shards cameras across nodes, provisions/tears down the
// underlying MediaMTX paths, and runs the idle-path reaper.
//
// Design (P2-A):
//   - MediaNode registry + StreamShard assignment live in the nvr DB
//     (neubit_nvr: media_nodes + stream_shards, migration 0002). Placement is a
//     pure data-plane concern, so it is kept nvr-side rather than as a read model
//     off vision — vision addresses streams by (camera_id, profile) via REST and
//     never touches these tables.
//   - Assign(cameraID, profile) picks a node: NVR-affinity (an existing shard
//     keeps its node) then least-loaded. P2 runs a SINGLE node, so Assign returns
//     that node; the seam for multi-node placement + node-loss reassignment is
//     wired but the real rebalance is stubbed for P6 (see reassignOnNodeLoss).
//   - EnsureStream provisions the MediaMTX path (client.EnsurePath) and persists
//     the shard. DropStream deletes the path + shard. Both are graceful when
//     MediaMTX / the camera RTSP is unreachable (never crash nvr).
//   - The reaper periodically lists paths and DeletePath-s any with 0 readers
//     idle for > VE_STREAM_IDLE_TTL_SEC.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/neubit/nvr/internal/mediamtx"
)

// Supervisor coordinates media nodes + shards. Construct with New, call
// EnsureNode at boot to register the local node, then Start to run the reaper.
type Supervisor struct {
	db     *pgxpool.Pool
	mtx    *mediamtx.Client
	idleT  time.Duration
	source string // service name, for logging

	mu    sync.RWMutex
	nodes map[string]mediamtx.Node // in-memory node cache (mirrors media_nodes)

	// idleSince tracks the first time a path was observed with 0 readers, so the
	// reaper only tears down paths idle for longer than idleT.
	idleSince map[string]time.Time

	// recordRebinder (P6-A) is the recording-supervisor's hook to re-enable record
	// on a shard's NEW node after a rebalance. Optional; guarded by mu.
	recordRebinder RecordRebinder
}

// Stream is the caller-facing result of an ensure — the URLs a browser plays.
type Stream struct {
	Name      string `json:"name"`
	Node      string `json:"node"`
	HLSURL    string `json:"hls_url"`
	WebRTCURL string `json:"webrtc_url"`
	RTSPURL   string `json:"rtsp_url"`
	Ready     bool   `json:"ready"`
	Readers   int    `json:"readers"`
}

// New builds a Supervisor. idleTTL is the reaper's idle threshold.
func New(db *pgxpool.Pool, mtx *mediamtx.Client, idleTTL time.Duration, source string) *Supervisor {
	if idleTTL <= 0 {
		idleTTL = 5 * time.Minute
	}
	return &Supervisor{
		db:        db,
		mtx:       mtx,
		idleT:     idleTTL,
		source:    source,
		nodes:     map[string]mediamtx.Node{},
		idleSince: map[string]time.Time{},
	}
}

// EnsureNode registers (upserts) a MediaMTX node in the registry + cache. In P2
// nvr calls this once at boot for its single local node; multi-node registration
// is the same call per node in P6.
func (s *Supervisor) EnsureNode(ctx context.Context, node mediamtx.Node) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO media_nodes (id, api_url, hls_base, webrtc_base, rtsp_base, healthy, last_seen_at, last_heartbeat)
		VALUES ($1, $2, $3, $4, $5, true, now(), now())
		ON CONFLICT (id) DO UPDATE SET
			api_url = EXCLUDED.api_url,
			hls_base = EXCLUDED.hls_base,
			webrtc_base = EXCLUDED.webrtc_base,
			rtsp_base = EXCLUDED.rtsp_base,
			healthy = true,
			last_seen_at = now(),
			last_heartbeat = now(),
			dead_since = NULL`,
		node.ID, node.APIURL, node.HLSBase, node.WebRTCBase, node.RTSPBase)
	if err != nil {
		return fmt.Errorf("register media node %q: %w", node.ID, err)
	}
	s.mu.Lock()
	s.nodes[node.ID] = node
	s.mu.Unlock()
	log.Printf("media node registered: %s (api=%s)", node.ID, node.APIURL)
	return nil
}

// ErrNoNodes is returned by Assign when the registry is empty.
var ErrNoNodes = errors.New("no media nodes registered")

// Assign picks the media node for a (tenant, camera, profile) stream.
//
//	NVR-affinity: if a shard already exists it keeps its node (sticky).
//	Least-loaded: otherwise the node serving the fewest shards wins.
//
// P2 has one node, so this returns that node; the affinity + load logic is the
// seam for P6 multi-node placement.
func (s *Supervisor) Assign(ctx context.Context, tenantID, cameraID, profile string) (mediamtx.Node, error) {
	// Affinity: reuse the node an existing shard is pinned to.
	var pinned string
	err := s.db.QueryRow(ctx,
		`SELECT node_id FROM stream_shards WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile).Scan(&pinned)
	if err == nil {
		if n, ok := s.node(pinned); ok {
			return n, nil
		}
		// Pinned node is gone — reassign (P2: falls through to least-loaded).
		log.Printf("shard %s/%s/%s pinned to missing node %q — reassigning", tenantID, cameraID, profile, pinned)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return mediamtx.Node{}, fmt.Errorf("lookup shard: %w", err)
	}

	return s.leastLoaded(ctx)
}

// leastLoaded returns the healthy node with the fewest shards. Single-node
// deployments always return that node.
func (s *Supervisor) leastLoaded(ctx context.Context) (mediamtx.Node, error) {
	s.mu.RLock()
	ids := make([]string, 0, len(s.nodes))
	for id := range s.nodes {
		ids = append(ids, id)
	}
	s.mu.RUnlock()
	if len(ids) == 0 {
		return mediamtx.Node{}, ErrNoNodes
	}
	if len(ids) == 1 {
		n, _ := s.node(ids[0])
		return n, nil
	}
	// Multi-node: pick min shard count. Rebalance-on-node-loss is P6.
	rows, err := s.db.Query(ctx,
		`SELECT node_id, count(*) FROM stream_shards WHERE node_id = ANY($1) GROUP BY node_id`, ids)
	if err != nil {
		return mediamtx.Node{}, fmt.Errorf("load counts: %w", err)
	}
	defer rows.Close()
	load := map[string]int{}
	for _, id := range ids {
		load[id] = 0
	}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return mediamtx.Node{}, err
		}
		load[id] = n
	}
	best := ids[0]
	for _, id := range ids {
		if load[id] < load[best] {
			best = id
		}
	}
	n, _ := s.node(best)
	return n, nil
}

func (s *Supervisor) node(id string) (mediamtx.Node, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n, ok := s.nodes[id]
	return n, ok
}

// EnsureStream assigns a node, provisions the MediaMTX path, persists the shard,
// and returns the playable Stream. Graceful: if MediaMTX is unreachable it
// returns an error the caller surfaces cleanly; the returned Stream's Ready
// reflects whether the source is actually pulling (on-demand paths are not ready
// until a reader connects, so Ready:false with no error is normal).
func (s *Supervisor) EnsureStream(ctx context.Context, tenantID, cameraID, profile, rtspURL string) (Stream, error) {
	if profile == "" {
		profile = "main"
	}
	node, err := s.Assign(ctx, tenantID, cameraID, profile)
	if err != nil {
		return Stream{}, err
	}
	name := mediamtx.PathName(tenantID, cameraID, profile)

	if err := s.mtx.EnsurePath(ctx, node, name, rtspURL, nil); err != nil {
		return Stream{}, err
	}

	// Persist the shard (idempotent upsert).
	if _, err := s.db.Exec(ctx, `
		INSERT INTO stream_shards (tenant_id, camera_id, profile, node_id, path_name, rtsp_url)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (tenant_id, camera_id, profile) DO UPDATE SET
			node_id = EXCLUDED.node_id,
			path_name = EXCLUDED.path_name,
			rtsp_url = EXCLUDED.rtsp_url,
			updated_at = now()`,
		tenantID, cameraID, profile, node.ID, name, rtspURL); err != nil {
		return Stream{}, fmt.Errorf("persist shard: %w", err)
	}

	st := Stream{
		Name:      name,
		Node:      node.ID,
		HLSURL:    mediamtx.HLSURL(node, name),
		WebRTCURL: mediamtx.WHEPURL(node, name),
		RTSPURL:   mediamtx.RTSPURL(node, name),
	}
	// Best-effort readiness probe — an unreachable source leaves Ready:false but
	// is NOT an error (the path exists; the source pulls on the first reader).
	if info, found, perr := s.mtx.PathState(ctx, node, name); perr == nil && found {
		st.Ready = info.Ready
		st.Readers = info.ReaderCount()
	}
	return st, nil
}

// DropStream deletes the MediaMTX path and the shard row. Idempotent: a missing
// path/shard is not an error.
func (s *Supervisor) DropStream(ctx context.Context, tenantID, cameraID, profile string) error {
	if profile == "" {
		profile = "main"
	}
	name := mediamtx.PathName(tenantID, cameraID, profile)

	// Prefer the shard's pinned node; fall back to the assigned node.
	var nodeID string
	_ = s.db.QueryRow(ctx,
		`SELECT node_id FROM stream_shards WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile).Scan(&nodeID)
	node, ok := s.node(nodeID)
	if !ok {
		if n, err := s.leastLoaded(ctx); err == nil {
			node = n
		}
	}

	// Delete the path (idempotent) then the shard.
	if err := s.mtx.DeletePath(ctx, node, name); err != nil {
		// Log but continue — a down node must not block shard cleanup.
		log.Printf("drop stream %s: mediamtx delete note: %v", name, err)
	}
	if _, err := s.db.Exec(ctx,
		`DELETE FROM stream_shards WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile); err != nil {
		return fmt.Errorf("drop shard: %w", err)
	}
	s.mu.Lock()
	delete(s.idleSince, name)
	s.mu.Unlock()
	return nil
}

// ListStreams returns the live state of every active shard (name/node/readers),
// merging the DB shard rows with the node's runtime path state.
func (s *Supervisor) ListStreams(ctx context.Context) ([]Stream, error) {
	rows, err := s.db.Query(ctx,
		`SELECT tenant_id, camera_id, profile, node_id, path_name FROM stream_shards ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("list shards: %w", err)
	}
	defer rows.Close()

	type shard struct{ tenant, cam, profile, nodeID, name string }
	var shards []shard
	for rows.Next() {
		var sh shard
		if err := rows.Scan(&sh.tenant, &sh.cam, &sh.profile, &sh.nodeID, &sh.name); err != nil {
			return nil, err
		}
		shards = append(shards, sh)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Cache per-node path listings so we probe each node once.
	pathCache := map[string]map[string]mediamtx.PathInfo{}
	out := make([]Stream, 0, len(shards))
	for _, sh := range shards {
		node, ok := s.node(sh.nodeID)
		if !ok {
			continue
		}
		if _, done := pathCache[sh.nodeID]; !done {
			m := map[string]mediamtx.PathInfo{}
			if infos, err := s.mtx.ListPaths(ctx, node); err == nil {
				for _, in := range infos {
					m[in.Name] = in
				}
			}
			pathCache[sh.nodeID] = m
		}
		st := Stream{
			Name:      sh.name,
			Node:      sh.nodeID,
			HLSURL:    mediamtx.HLSURL(node, sh.name),
			WebRTCURL: mediamtx.WHEPURL(node, sh.name),
			RTSPURL:   mediamtx.RTSPURL(node, sh.name),
		}
		if info, ok := pathCache[sh.nodeID][sh.name]; ok {
			st.Ready = info.Ready
			st.Readers = info.ReaderCount()
		}
		out = append(out, st)
	}
	return out, nil
}

// Start launches the idle-path reaper loop; it stops when ctx is cancelled.
func (s *Supervisor) Start(ctx context.Context) {
	interval := s.idleT / 2
	if interval < 30*time.Second {
		interval = 30 * time.Second
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		log.Printf("idle-path reaper started (ttl=%s, interval=%s)", s.idleT, interval)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.reap(ctx)
			}
		}
	}()
}

// reap lists every node's paths and deletes those that map to a known shard and
// have had 0 readers for longer than idleT. First observation of an idle path
// starts its idle timer; a reader resets it.
func (s *Supervisor) reap(ctx context.Context) {
	// Build the set of shard path names so the reaper only touches OUR paths.
	shardPaths := map[string]struct{}{}
	rows, err := s.db.Query(ctx, `SELECT path_name FROM stream_shards`)
	if err != nil {
		log.Printf("reaper: list shards: %v", err)
		return
	}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err == nil {
			shardPaths[p] = struct{}{}
		}
	}
	rows.Close()

	s.mu.RLock()
	nodes := make([]mediamtx.Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		nodes = append(nodes, n)
	}
	s.mu.RUnlock()

	now := time.Now()
	for _, node := range nodes {
		infos, err := s.mtx.ListPaths(ctx, node)
		if err != nil {
			continue // node unreachable — try again next tick
		}
		live := map[string]struct{}{}
		for _, in := range infos {
			live[in.Name] = struct{}{}
			if _, ours := shardPaths[in.Name]; !ours {
				continue
			}
			if in.ReaderCount() > 0 {
				s.mu.Lock()
				delete(s.idleSince, in.Name)
				s.mu.Unlock()
				continue
			}
			// 0 readers — track idle age.
			s.mu.Lock()
			since, seen := s.idleSince[in.Name]
			if !seen {
				s.idleSince[in.Name] = now
				s.mu.Unlock()
				continue
			}
			idleFor := now.Sub(since)
			s.mu.Unlock()
			if idleFor >= s.idleT {
				if err := s.mtx.DeletePath(ctx, node, in.Name); err != nil {
					log.Printf("reaper: delete idle path %s: %v", in.Name, err)
					continue
				}
				log.Printf("reaper: deleted idle path %s (idle %s)", in.Name, idleFor.Round(time.Second))
				s.mu.Lock()
				delete(s.idleSince, in.Name)
				s.mu.Unlock()
			}
		}
		// Forget idle timers for paths that vanished.
		s.mu.Lock()
		for name := range s.idleSince {
			if _, ok := live[name]; !ok {
				delete(s.idleSince, name)
			}
		}
		s.mu.Unlock()
	}
}
