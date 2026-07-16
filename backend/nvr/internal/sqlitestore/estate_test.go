package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/neubit/nvr/internal/store"
)

func estateDB(t *testing.T) (*DB, context.Context) {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db, ctx
}

func TestNVRCRUD(t *testing.T) {
	db, ctx := estateDB(t)
	now := time.Now().UTC()
	if err := db.CreateNVR(ctx, store.NVR{ID: "n1", Name: "Lobby DVR", Brand: "hikvision", Host: "10.0.0.9", Port: 80, ChannelCount: 16, Status: "online", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := db.GetNVR(ctx, "n1")
	if err != nil || got.Host != "10.0.0.9" || got.ChannelCount != 16 {
		t.Fatalf("get: %+v err=%v", got, err)
	}
	got.Status = "offline"
	got.UpdatedAt = now.Add(time.Minute)
	if err := db.UpdateNVR(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	list, _ := db.ListNVRs(ctx)
	if len(list) != 1 || list[0].Status != "offline" {
		t.Fatalf("list: %+v", list)
	}
	if err := db.DeleteNVR(ctx, "n1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := db.GetNVR(ctx, "n1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestRecordingTargetsAndSegments(t *testing.T) {
	db, ctx := estateDB(t)
	now := time.Now().UTC()

	// Target upsert keyed by (tenant,camera,profile).
	tgt := store.RecordingTarget{TenantID: "t1", CameraID: "c1", Profile: "main", PathName: "cameras/t1/c1/main", RecordPath: "/rec/%path", Active: true, TriggerType: "continuous", CreatedAt: now, UpdatedAt: now}
	if err := db.UpsertRecordingTarget(ctx, tgt); err != nil {
		t.Fatalf("target upsert: %v", err)
	}
	tgt.Active = false
	if err := db.UpsertRecordingTarget(ctx, tgt); err != nil {
		t.Fatalf("target re-upsert: %v", err)
	}
	targets, _ := db.ListRecordingTargets(ctx)
	if len(targets) != 1 || targets[0].Active {
		t.Fatalf("targets: %+v", targets)
	}

	// Segment ledger — first insert new, second is a dup (emit-once).
	seg := store.RecordingSegment{Path: "/rec/a.mp4", TenantID: "t1", CameraID: "c1", Profile: "main", StartedAt: &now, TriggerType: "continuous", IntegrityStatus: "unchecked"}
	inserted, err := db.UpsertRecordingSegment(ctx, seg)
	if err != nil || !inserted {
		t.Fatalf("segment insert: inserted=%v err=%v", inserted, err)
	}
	inserted2, _ := db.UpsertRecordingSegment(ctx, seg)
	if inserted2 {
		t.Fatalf("dup segment should not report inserted")
	}

	// Time-window listing + evidence lock.
	from := now.Add(-time.Hour)
	to := now.Add(time.Hour)
	segs, _ := db.ListSegments(ctx, store.SegmentFilter{CameraID: "c1", From: &from, To: &to})
	if len(segs) != 1 {
		t.Fatalf("segments in window: %d", len(segs))
	}
	if err := db.LockSegment(ctx, "/rec/a.mp4", "u-admin"); err != nil {
		t.Fatalf("lock: %v", err)
	}
	locked, _ := db.ListSegments(ctx, store.SegmentFilter{CameraID: "c1"})
	if !locked[0].Locked || locked[0].LockedBy == nil || *locked[0].LockedBy != "u-admin" {
		t.Fatalf("lock not persisted: %+v", locked[0])
	}
	db.UnlockSegment(ctx, "/rec/a.mp4")
	unlocked, _ := db.ListSegments(ctx, store.SegmentFilter{CameraID: "c1"})
	if unlocked[0].Locked {
		t.Fatalf("unlock failed")
	}

	// Delete target.
	if err := db.DeleteRecordingTarget(ctx, "t1", "c1", "main"); err != nil {
		t.Fatalf("delete target: %v", err)
	}
	if targets, _ := db.ListRecordingTargets(ctx); len(targets) != 0 {
		t.Fatalf("target not deleted")
	}
}

func TestStorageAndRaid(t *testing.T) {
	db, ctx := estateDB(t)
	now := time.Now().UTC()
	max := int64(1 << 40)
	reach := true
	pool := store.StoragePool{ID: "p1", Name: "local", PoolType: "local", IsDefault: true, IsActive: true, MaxSizeBytes: &max, Reachable: &reach, S3UseSSL: true, CreatedAt: now, UpdatedAt: now}
	if err := db.CreateStoragePool(ctx, pool); err != nil {
		t.Fatalf("pool create: %v", err)
	}
	got, err := db.GetStoragePool(ctx, "p1")
	if err != nil || got.MaxSizeBytes == nil || *got.MaxSizeBytes != max || got.Reachable == nil || !*got.Reachable {
		t.Fatalf("pool get: %+v err=%v", got, err)
	}
	// Second pool + tier rule between them.
	db.CreateStoragePool(ctx, store.StoragePool{ID: "p2", Name: "cold", PoolType: "s3", CreatedAt: now, UpdatedAt: now})
	if err := db.CreateTierRule(ctx, store.TierRule{ID: "r1", Name: "age-out", SourcePoolID: "p1", TargetPoolID: "p2", AfterAgeHours: 168, Enabled: true, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("tier create: %v", err)
	}
	if rules, _ := db.ListTierRules(ctx); len(rules) != 1 || rules[0].AfterAgeHours != 168 {
		t.Fatalf("tier list: %+v", rules)
	}

	// RAID upsert (device-keyed).
	if err := db.UpsertRaidArray(ctx, store.RaidArray{Device: "/dev/md0", Level: "raid5", Health: "healthy", TotalDevices: 4, WorkingDevices: 4, LastSeenAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("raid: %v", err)
	}
	db.UpsertRaidArray(ctx, store.RaidArray{Device: "/dev/md0", Level: "raid5", Health: "degraded", TotalDevices: 4, WorkingDevices: 3, FailedDevices: 1, LastSeenAt: now, UpdatedAt: now})
	arrays, _ := db.ListRaidArrays(ctx)
	if len(arrays) != 1 || arrays[0].Health != "degraded" || arrays[0].FailedDevices != 1 {
		t.Fatalf("raid upsert: %+v", arrays)
	}
}

func TestPTZ(t *testing.T) {
	db, ctx := estateDB(t)
	now := time.Now().UTC()
	if err := db.CreatePtzPreset(ctx, store.PtzPreset{ID: "pr1", CameraID: "c1", Name: "Gate", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("preset: %v", err)
	}
	if ps, _ := db.ListPtzPresets(ctx, "c1"); len(ps) != 1 || ps[0].Name != "Gate" {
		t.Fatalf("preset list: %+v", ps)
	}
	if err := db.CreatePtzPatrol(ctx, store.PtzPatrol{ID: "pa1", CameraID: "c1", Name: "Night", Speed: 0.5, IsActive: true, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("patrol: %v", err)
	}
	pats, _ := db.ListPtzPatrols(ctx, "c1")
	if len(pats) != 1 {
		t.Fatalf("patrol list: %d", len(pats))
	}
	pats[0].IsRunning = true
	pats[0].UpdatedAt = now.Add(time.Minute)
	if err := db.UpdatePtzPatrol(ctx, pats[0]); err != nil {
		t.Fatalf("patrol update: %v", err)
	}
	again, _ := db.ListPtzPatrols(ctx, "c1")
	if !again[0].IsRunning {
		t.Fatalf("patrol update lost")
	}
	db.DeletePtzPreset(ctx, "pr1")
	db.DeletePtzPatrol(ctx, "pa1")
	if ps, _ := db.ListPtzPresets(ctx, "c1"); len(ps) != 0 {
		t.Fatalf("preset not deleted")
	}
}

func TestShardsAndAnr(t *testing.T) {
	db, ctx := estateDB(t)
	now := time.Now().UTC()

	// media node must exist before a shard (FK).
	if err := db.UpsertMediaNode(ctx, store.MediaNode{ID: "mediamtx-0", APIURL: "http://localhost:9997", HLSBase: "h", WebRTCBase: "w", RTSPBase: "r", Healthy: true, LastSeenAt: now, LastHeartbeat: now, CreatedAt: now}); err != nil {
		t.Fatalf("node: %v", err)
	}
	if n, err := db.GetMediaNode(ctx, "mediamtx-0"); err != nil || !n.Healthy {
		t.Fatalf("node get: %+v err=%v", n, err)
	}
	if err := db.UpsertStreamShard(ctx, store.StreamShard{TenantID: "t1", CameraID: "c1", Profile: "main", NodeID: "mediamtx-0", PathName: "p", RTSPURL: "rtsp://x"}); err != nil {
		t.Fatalf("shard: %v", err)
	}
	shards, _ := db.ListStreamShards(ctx)
	if len(shards) != 1 || shards[0].NodeID != "mediamtx-0" {
		t.Fatalf("shard list: %+v", shards)
	}
	db.DeleteStreamShard(ctx, "t1", "c1", "main")
	if shards, _ := db.ListStreamShards(ctx); len(shards) != 0 {
		t.Fatalf("shard not deleted")
	}

	// ANR job lifecycle: create → claim (queued→running) → update done.
	id, err := db.CreateAnrJob(ctx, store.AnrJob{TenantID: "t1", CameraID: "c1", Profile: "main", GapFrom: now.Add(-time.Hour), GapTo: now})
	if err != nil || id == 0 {
		t.Fatalf("anr create: id=%d err=%v", id, err)
	}
	claimed, err := db.ClaimAnrJob(ctx)
	if err != nil || claimed.ID != id || claimed.Status != "running" {
		t.Fatalf("claim: %+v err=%v", claimed, err)
	}
	if _, err := db.ClaimAnrJob(ctx); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("empty queue should be ErrNotFound, got %v", err)
	}
	claimed.Status = "done"
	claimed.BackfilledSegments = 3
	done := now
	claimed.CompletedAt = &done
	if err := db.UpdateAnrJob(ctx, claimed); err != nil {
		t.Fatalf("anr update: %v", err)
	}
	jobs, _ := db.ListAnrJobs(ctx, "c1")
	if len(jobs) != 1 || jobs[0].Status != "done" || jobs[0].BackfilledSegments != 3 {
		t.Fatalf("anr list: %+v", jobs)
	}
}
