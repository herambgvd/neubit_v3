// Rebalance-on-node-loss (P6-A) — the real implementation of the P2-A stub.
//
// Design:
//   - Every media node carries a `last_heartbeat` in media_nodes. EnsureNode
//     stamps it; the monitor tick re-stamps a node whose control API answers
//     Healthy (a live liveness probe), so a node that is genuinely up keeps its
//     heartbeat fresh even without re-registration.
//   - A node with no heartbeat within deadAfter is marked dead (healthy=false,
//     dead_since=now, dropped from the in-memory cache) and its shards are
//     REASSIGNED to the least-loaded healthy node: the live MediaMTX path is
//     re-ensured on the survivor, and — for cameras that were recording — record
//     is re-enabled there via the RecordRebinder hook. Idempotent: a shard already
//     pointing at a healthy node is skipped, and a re-run reassigns nothing.
//   - Single-node dev has nowhere to reassign TO, so the monitor logs the dead
//     node and the (unit-tested) ReassignFrom returns cleanly with 0 moves; the
//     reassign LOGIC is exercised by registering a 2nd node (or the test marking
//     the sole node dead with a survivor present).
package supervisor

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/neubit/nvr/internal/mediamtx"
)

// RecordRebinder is the seam the recording-supervisor implements so the
// stream-supervisor can re-enable recording on a shard's NEW node after a
// rebalance (without importing the recording package — that would be a cycle).
// The recording-supervisor registers itself via SetRecordRebinder at wire-up.
type RecordRebinder interface {
	// RebindRecording re-asserts record on the given (tenant, camera, profile)
	// against its now-current node. It is a no-op if the camera was not recording.
	// Best-effort — a down MediaMTX must not abort the rebalance sweep.
	RebindRecording(ctx context.Context, tenantID, cameraID, profile string)
}

// SetRecordRebinder wires the recording-supervisor's rebind hook. Optional — with
// no rebinder, rebalance still moves live shards (recording rebind is skipped).
func (s *Supervisor) SetRecordRebinder(rb RecordRebinder) {
	s.mu.Lock()
	s.recordRebinder = rb
	s.mu.Unlock()
}

// StartHealthMonitor launches the node-heartbeat monitor loop. Every `interval`
// it probes each node's control API (refreshing the heartbeat of live nodes),
// then marks dead any node whose heartbeat is older than `deadAfter` and
// reassigns its shards. Stops when ctx is cancelled.
func (s *Supervisor) StartHealthMonitor(ctx context.Context, interval, deadAfter time.Duration) {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	if deadAfter <= 0 {
		deadAfter = 45 * time.Second
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		log.Printf("node health monitor started (interval=%s, dead-after=%s)", interval, deadAfter)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.monitorTick(ctx, deadAfter)
			}
		}
	}()
}

// monitorTick refreshes live nodes' heartbeats and reassigns any that have gone
// dead. It is safe to call repeatedly (idempotent) and never panics on a down
// node — a failed probe simply lets the heartbeat age toward the dead threshold.
func (s *Supervisor) monitorTick(ctx context.Context, deadAfter time.Duration) {
	// 1. Liveness probe: a node whose control API answers refreshes its heartbeat.
	s.mu.RLock()
	nodes := make([]mediamtx.Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		nodes = append(nodes, n)
	}
	s.mu.RUnlock()
	for _, n := range nodes {
		if s.mtx.Healthy(ctx, n) {
			s.touchHeartbeat(ctx, n.ID)
		}
	}

	// 2. Find nodes past the dead threshold (by DB heartbeat — the source of
	//    truth across restarts) and reassign each.
	dead, err := s.deadNodes(ctx, deadAfter)
	if err != nil {
		log.Printf("health monitor: list dead nodes: %v", err)
		return
	}
	for _, id := range dead {
		if err := s.markDeadAndReassign(ctx, id); err != nil {
			log.Printf("health monitor: reassign from dead node %q: %v", id, err)
		}
	}
}

// touchHeartbeat stamps a node's last_heartbeat (and clears a stale dead flag if
// the node has recovered).
func (s *Supervisor) touchHeartbeat(ctx context.Context, nodeID string) {
	_, err := s.db.Exec(ctx,
		`UPDATE media_nodes SET last_heartbeat = now(), healthy = true, dead_since = NULL WHERE id = $1`,
		nodeID)
	if err != nil {
		log.Printf("heartbeat update %q: %v", nodeID, err)
	}
}

// deadNodes returns the ids of nodes whose last_heartbeat is older than deadAfter
// and that are not already fully processed (still cached / still healthy). We
// filter on the heartbeat age in SQL so the DB clock is authoritative.
func (s *Supervisor) deadNodes(ctx context.Context, deadAfter time.Duration) ([]string, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id FROM media_nodes
		WHERE last_heartbeat < now() - make_interval(secs => $1)`,
		deadAfter.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// MarkNodeDead forces a node dead immediately (heartbeat in the past) — the test
// seam that lets single-node dev exercise the reassign path without waiting for
// the timeout. It does NOT reassign; call ReassignFrom (or let the monitor tick).
func (s *Supervisor) MarkNodeDead(ctx context.Context, nodeID string) error {
	_, err := s.db.Exec(ctx,
		`UPDATE media_nodes SET healthy = false, dead_since = now(),
		 last_heartbeat = now() - interval '1 year' WHERE id = $1`, nodeID)
	if err != nil {
		return fmt.Errorf("mark node dead %q: %w", nodeID, err)
	}
	s.mu.Lock()
	delete(s.nodes, nodeID)
	s.mu.Unlock()
	return nil
}

// markDeadAndReassign flips a node dead (healthy=false, dead_since, drop from
// cache) then reassigns its shards. Idempotent — a node already dead just
// re-drives the reassign for any shards still pinned to it.
func (s *Supervisor) markDeadAndReassign(ctx context.Context, nodeID string) error {
	if _, err := s.db.Exec(ctx,
		`UPDATE media_nodes SET healthy = false,
		 dead_since = COALESCE(dead_since, now()) WHERE id = $1`, nodeID); err != nil {
		return fmt.Errorf("flag node dead %q: %w", nodeID, err)
	}
	s.mu.Lock()
	delete(s.nodes, nodeID)
	s.mu.Unlock()
	log.Printf("media node %q marked DEAD — reassigning its shards", nodeID)
	return s.ReassignFrom(ctx, nodeID)
}

// ReassignFrom moves every stream_shard (and recording_target) pinned to deadID
// onto the least-loaded HEALTHY node: it re-ensures the live MediaMTX path on the
// survivor, repoints the shard/target rows, and re-enables record for recording
// cameras via the RecordRebinder. Returns nil (0 moves) when there is no healthy
// survivor (single-node dev) — the shards stay pinned and are retried when a node
// re-registers. Idempotent + graceful (a per-shard failure is logged, the sweep
// continues).
func (s *Supervisor) ReassignFrom(ctx context.Context, deadID string) error {
	// Gather the orphaned live shards.
	rows, err := s.db.Query(ctx,
		`SELECT tenant_id, camera_id, profile, path_name, rtsp_url, redundant
		 FROM stream_shards WHERE node_id = $1`, deadID)
	if err != nil {
		return fmt.Errorf("list orphaned shards: %w", err)
	}
	type shard struct {
		tenant, cam, profile, name, rtsp string
		redundant                        bool
	}
	var shards []shard
	for rows.Next() {
		var sh shard
		if err := rows.Scan(&sh.tenant, &sh.cam, &sh.profile, &sh.name, &sh.rtsp, &sh.redundant); err == nil {
			shards = append(shards, sh)
		}
	}
	rows.Close()

	if len(shards) == 0 {
		return nil // nothing pinned here
	}

	moved := 0
	for _, sh := range shards {
		// Pick a healthy survivor that is NOT the dead node.
		target, err := s.leastLoadedExcluding(ctx, deadID)
		if err != nil {
			// No survivor (single-node dev): log once and stop — the shards stay
			// put and get reassigned when a replacement node registers.
			log.Printf("reassign: no healthy survivor for shard %s (was on %s) — deferring", sh.name, deadID)
			return nil
		}

		// Re-ensure the live path on the survivor (best-effort; on-demand source).
		if err := s.mtx.EnsurePath(ctx, target, sh.name, sh.rtsp, nil); err != nil {
			log.Printf("reassign: ensure path %s on %s: %v", sh.name, target.ID, err)
			// Still repoint the row — the reconcile/next reader will re-provision.
		}

		// Repoint the shard.
		if _, err := s.db.Exec(ctx,
			`UPDATE stream_shards SET node_id = $1, updated_at = now()
			 WHERE tenant_id = $2 AND camera_id = $3 AND profile = $4`,
			target.ID, sh.tenant, sh.cam, sh.profile); err != nil {
			log.Printf("reassign: repoint shard %s: %v", sh.name, err)
			continue
		}

		// Repoint any recording target on this camera to the survivor + re-enable
		// record there (the recording-supervisor's rebind hook drives MediaMTX).
		if _, err := s.db.Exec(ctx,
			`UPDATE recording_targets SET node_id = $1, updated_at = now()
			 WHERE tenant_id = $2 AND camera_id = $3 AND profile = $4 AND node_id = $5`,
			target.ID, sh.tenant, sh.cam, sh.profile, deadID); err != nil {
			log.Printf("reassign: repoint recording target %s: %v", sh.name, err)
		}
		if rb := s.rebinder(); rb != nil {
			rb.RebindRecording(ctx, sh.tenant, sh.cam, sh.profile)
		}

		moved++
		log.Printf("reassigned shard %s: %s → %s (record re-enabled if active)", sh.name, deadID, target.ID)
	}
	log.Printf("rebalance from %q complete: %d/%d shards moved", deadID, moved, len(shards))
	return nil
}

// leastLoadedExcluding returns the healthy node with the fewest shards, EXCLUDING
// excludeID (the dead node). Used both by rebalance and by redundant-recording's
// secondary-node pick. Returns ErrNoNodes when no other healthy node exists.
func (s *Supervisor) leastLoadedExcluding(ctx context.Context, excludeID string) (mediamtx.Node, error) {
	s.mu.RLock()
	ids := make([]string, 0, len(s.nodes))
	for id := range s.nodes {
		if id == excludeID {
			continue
		}
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
		if err := rows.Scan(&id, &n); err == nil {
			load[id] = n
		}
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

// rebinder returns the currently-wired RecordRebinder (nil if none).
func (s *Supervisor) rebinder() RecordRebinder {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.recordRebinder
}

// SecondaryNode picks a secondary media node for redundant recording of a camera
// currently on primaryID: the least-loaded healthy node OTHER than the primary.
// Returns ok=false when there is no second node (single-node dev) — the caller
// then records single-copy and re-tries the secondary on the next node join.
func (s *Supervisor) SecondaryNode(ctx context.Context, primaryID string) (mediamtx.Node, bool) {
	n, err := s.leastLoadedExcluding(ctx, primaryID)
	if err != nil {
		return mediamtx.Node{}, false
	}
	return n, true
}
