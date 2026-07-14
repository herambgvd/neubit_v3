# Node Agent Core Implementation Plan (Sub-project 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Go `nvr` service into an autonomous, self-sufficient mini-VMS that owns its estate in an embedded SQLite store, is fully configurable/recordable standalone (no external DB, no central), and exposes the node-side federation contract — all behind a `NVR_STORE=sqlite` flag so the current Postgres-backed system keeps working untouched.

**Architecture:** Introduce a `Store` interface in the Go `nvr` service with two backends: the existing Postgres path (`pgstore`, default) and a new embedded-SQLite path (`sqlitestore`). SQLite owns the full estate (cameras, media_profiles, recording config/targets/segments, storage+RAID, PTZ, ANR) plus node-only tables (identity, local users/sessions, audit, outbound queue). New `/api/v1/nvr/estate/*` endpoints give full local CRUD; a dual-mode auth middleware accepts central JWT / node credential / local session; the node issues+verifies its own media tokens; federation (enroll/heartbeat/snapshot/override/offline-queue) is built node-side but stubbed behind `federation.enabled=false`.

**Tech Stack:** Go 1.22+, chi router, `modernc.org/sqlite` (pure-Go, CGO-free), `gokernel` (shared auth/db/httpx), argon2id (shared hasher), MediaMTX (co-located), NATS (best-effort). Spec: `docs/superpowers/specs/2026-07-14-node-agent-core-design.md`.

---

## Ground rules for the executor

- **Non-destructive:** every change is additive and gated by `NVR_STORE` (values `postgres` default | `sqlite`) and `FEDERATION_ENABLED` (default `false`). Do NOT delete the Postgres path or the `nvr/migrations/` Postgres set in SP1. The running stack must keep booting with `NVR_STORE=postgres`.
- **Repo:** all paths are under `/Users/snowden/command_center_work/neubit_v3`. The Go service is `backend/nvr` (module `github.com/neubit/nvr`), shared kernel is `backend/gokernel` (module `github.com/neubit/gokernel`).
- **Test runner:** `cd backend/nvr && go test ./...`. Per-package: `go test ./internal/sqlitestore/ -run TestName -v`.
- **DB in tests:** SQLite tests use a temp file `t.TempDir()+"/node.db"` (never `:memory:` — it defeats WAL + multi-conn tests). Postgres tests keep using the existing `internal/anr/testdb_test.go` harness; do not touch it.
- **Commits:** one commit per task (end of each task's last step). Branch: `feat/node-agent-core` (create it first; do NOT commit to `main`/`feat/vms`).
- **Read before writing:** the spec (above) is the source of truth for every column and endpoint. When a task says "mirror the model", open the referenced `vision` model file and match field names.

---

## File structure (what gets created)

```
backend/nvr/
  go.mod                                  # + modernc.org/sqlite
  main.go                                 # MODIFY: pick store by NVR_STORE; wire estate router + auth + federation
  internal/
    store/
      store.go                            # NEW: Store interface (the seam both backends implement)
      types.go                            # NEW: shared Go structs (Camera, MediaProfile, NVR, StoragePool, ...)
    sqlitestore/
      sqlite.go                           # NEW: Open() (WAL/busy_timeout/pragmas), serialized writer
      migrate.go                          # NEW: SQLite migration runner (mirrors gokernel/db.Migrate)
      migrations/                         # NEW: embedded .sql
        0001_estate.sql                   # NEW: every table in spec §4
      cameras.go                          # NEW: camera + media_profile repo
      nvrs.go                             # NEW: nvr repo
      recording.go                        # NEW: recording_targets + recording_segments repo
      storage.go                          # NEW: storage_pools + tier_rules + raid_arrays repo
      ptz.go                              # NEW: ptz_presets + ptz_patrols repo
      shards.go                           # NEW: media_nodes + stream_shards repo
      anr.go                              # NEW: anr_jobs repo
      identity.go                         # NEW: node_identity repo
      localauth.go                        # NEW: local_users + local_sessions repo
      audit.go                            # NEW: audit_log repo
      outbound.go                         # NEW: outbound_queue repo
    pgstore/
      pgstore.go                          # NEW: thin adapter wrapping today's Postgres queries behind Store (default)
    identity/
      identity.go                         # NEW: bootstrap (first-boot) + secret-key root
      enroll.go                           # NEW: enroll client (join-token -> node credential)
    localauth/
      middleware.go                       # NEW: dual-mode auth -> unified Caller
      service.go                          # NEW: login/logout/session, local-user CRUD, argon2 via gokernel
    mediatoken/
      mediatoken.go                       # NEW: node-issued media token mint + verify (HMAC)
    estate/
      router.go                           # NEW: mounts /api/v1/nvr/estate/*
      cameras.go                          # NEW: camera handlers
      nvrs.go                             # NEW: nvr handlers
      recording.go                        # NEW: recording-config handlers
      storage.go                          # NEW: storage/raid handlers
      ptz.go                              # NEW: ptz handlers
      live.go                             # NEW: live/playback/recordings (node-issued media)
      node.go                             # NEW: node self + health + local-auth + import
    federation/
      federation.go                       # NEW: config flag + wiring
      snapshot.go                         # NEW: estate snapshot builder (versioned + hash)
      outboundq.go                        # NEW: queue drainer
      heartbeat.go                        # NEW: heartbeat loop
      override.go                         # NEW: override-accept handler
  README.md                               # MODIFY: document NVR_STORE + standalone boot
```

---

## Phase 0 — Seam + dependency (no behaviour change)

### Task 0.1: Add the SQLite dependency

**Files:**
- Modify: `backend/nvr/go.mod`

- [ ] **Step 1: Add the module**

Run: `cd backend/nvr && go get modernc.org/sqlite@latest`
Expected: `go.mod` gains `modernc.org/sqlite vX.Y.Z` and `go.sum` updates.

- [ ] **Step 2: Verify it builds**

Run: `cd backend/nvr && go build ./...`
Expected: success, no output.

- [ ] **Step 3: Commit**

```bash
git checkout -b feat/node-agent-core
git add backend/nvr/go.mod backend/nvr/go.sum
git commit -m "chore(nvr): add modernc.org/sqlite (pure-Go embedded store)"
```

### Task 0.2: Define the `Store` interface + shared types

The `Store` seam lets `main.go` pick a backend. Start with the methods the EXISTING engines already need (so pgstore can wrap current queries); estate methods are added per-phase.

**Files:**
- Create: `backend/nvr/internal/store/store.go`
- Create: `backend/nvr/internal/store/types.go`
- Test: `backend/nvr/internal/store/store_test.go`

- [ ] **Step 1: Write the failing test (interface compiles + zero value)**

```go
package store

import "testing"

func TestStoreInterfaceShape(t *testing.T) {
	var s Store // nil is fine; we assert the type exists + method set compiles
	_ = s
	c := Camera{ID: "x", Name: "cam"}
	if c.ID != "x" {
		t.Fatalf("Camera struct broken")
	}
}
```

- [ ] **Step 2: Run it — fails (package/type missing)**

Run: `cd backend/nvr && go test ./internal/store/ -run TestStoreInterfaceShape -v`
Expected: build error `undefined: Store` / `undefined: Camera`.

- [ ] **Step 3: Write `types.go` (mirror spec §4 columns as Go structs)**

Define exported structs with JSON tags matching the estate API shapes. Include at least: `Camera`, `MediaProfile`, `NVR`, `RecordingTarget`, `RecordingSegment`, `StoragePool`, `TierRule`, `RaidArray`, `PtzPreset`, `PtzPatrol`, `MediaNode`, `StreamShard`, `AnrJob`, `NodeIdentity`, `LocalUser`, `LocalSession`, `AuditEntry`, `OutboundMsg`. Use `time.Time` for timestamps (the SQLite layer converts to/from RFC3339 TEXT), `map[string]any`/`json.RawMessage` for JSON columns, `*string`/`*int` for nullable scalars. (Full field list = the columns in spec §4.2–§4.13.)

- [ ] **Step 4: Write `store.go` (the interface)**

```go
package store

import "context"

// Store is the persistence seam. Two backends implement it: pgstore (default,
// wraps today's Postgres) and sqlitestore (the autonomous node). Methods are
// grouped; estate methods are added in later phases.
type Store interface {
	// lifecycle
	Migrate(ctx context.Context) error
	Close() error

	// --- engine-facing (already used by streams/recording/playback/anr) ---
	UpsertStreamShard(ctx context.Context, s StreamShard) error
	DeleteStreamShard(ctx context.Context, tenantID, cameraID, profile string) error
	ListRecordingTargets(ctx context.Context) ([]RecordingTarget, error)
	UpsertRecordingSegment(ctx context.Context, seg RecordingSegment) (inserted bool, err error)
	// ... (add the exact methods the current internal/{streams,recording,playback,anr} call;
	//      extract them from those packages in Task 2.1 — one method per current query)

	// estate + identity + federation methods are declared in their phases.
}
```

- [ ] **Step 5: Run the test — passes**

Run: `cd backend/nvr && go test ./internal/store/ -run TestStoreInterfaceShape -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/nvr/internal/store/
git commit -m "feat(nvr): add Store seam + shared estate types"
```

---

## Phase 1 — Embedded SQLite store + migrations + identity bootstrap

### Task 1.1: `Open()` — WAL, pragmas, serialized writer

**Files:**
- Create: `backend/nvr/internal/sqlitestore/sqlite.go`
- Test: `backend/nvr/internal/sqlitestore/sqlite_test.go`

- [ ] **Step 1: Write the failing test**

```go
package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"
)

func TestOpenAppliesPragmas(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	var jm string
	if err := db.rw.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&jm); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if jm != "wal" {
		t.Fatalf("journal_mode = %q, want wal", jm)
	}
}
```

- [ ] **Step 2: Run — fails (`undefined: Open`)**

Run: `cd backend/nvr && go test ./internal/sqlitestore/ -run TestOpenAppliesPragmas -v`
Expected: build error.

- [ ] **Step 3: Implement `Open()`**

```go
package sqlitestore

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// DB wraps two handles: a single serialized writer (SQLite is single-writer) and
// a small read pool. WAL lets readers run concurrently with the writer.
type DB struct {
	rw *sql.DB // MaxOpenConns(1): the one writer
	ro *sql.DB // read pool
}

func Open(path string) (*DB, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)&_pragma=synchronous(NORMAL)"
	rw, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open rw: %w", err)
	}
	rw.SetMaxOpenConns(1) // serialize writes
	ro, err := sql.Open("sqlite", dsn)
	if err != nil {
		rw.Close()
		return nil, fmt.Errorf("open ro: %w", err)
	}
	ro.SetMaxOpenConns(4)
	return &DB{rw: rw, ro: ro}, nil
}

func (d *DB) Close() error {
	e1 := d.rw.Close()
	if err := d.ro.Close(); err != nil {
		return err
	}
	return e1
}
```

- [ ] **Step 4: Run — passes**

Run: `cd backend/nvr && go test ./internal/sqlitestore/ -run TestOpenAppliesPragmas -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/nvr/internal/sqlitestore/sqlite.go backend/nvr/internal/sqlitestore/sqlite_test.go
git commit -m "feat(nvr): SQLite Open() with WAL + serialized writer"
```

### Task 1.2: Migration runner + `0001_estate.sql`

**Files:**
- Create: `backend/nvr/internal/sqlitestore/migrate.go`
- Create: `backend/nvr/internal/sqlitestore/migrations/0001_estate.sql`
- Test: `backend/nvr/internal/sqlitestore/migrate_test.go`

- [ ] **Step 1: Write the failing test (apply once, idempotent, tables exist)**

```go
package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigrateCreatesTablesIdempotent(t *testing.T) {
	db, _ := Open(filepath.Join(t.TempDir(), "node.db"))
	defer db.Close()
	ctx := context.Background()

	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate #1: %v", err)
	}
	if err := db.Migrate(ctx); err != nil { // idempotent
		t.Fatalf("migrate #2: %v", err)
	}
	for _, tbl := range []string{"cameras", "media_profiles", "recording_targets", "recording_segments", "storage_pools", "raid_arrays", "ptz_presets", "node_identity", "local_users", "audit_log", "outbound_queue", "_migrations"} {
		var n int
		row := db.ro.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", tbl)
		if err := row.Scan(&n); err != nil || n != 1 {
			t.Fatalf("table %s missing (n=%d err=%v)", tbl, n, err)
		}
	}
}
```

- [ ] **Step 2: Run — fails (`undefined: Migrate`)**

Run: `cd backend/nvr && go test ./internal/sqlitestore/ -run TestMigrateCreatesTablesIdempotent -v`
Expected: build error.

- [ ] **Step 3: Write `0001_estate.sql`**

Paste EVERY `CREATE TABLE` / `CREATE INDEX` from spec §4.2–§4.13 verbatim into this one file, in dependency order (referenced tables first: `cameras` before `media_profiles`; `media_nodes` before `stream_shards`). End with the `_migrations` table's own creation being handled by the runner (Step 4), not this file.

- [ ] **Step 4: Write `migrate.go` (mirror `gokernel/db.Migrate`)**

```go
package sqlitestore

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func (d *DB) Migrate(ctx context.Context) error {
	if _, err := d.rw.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`); err != nil {
		return fmt.Errorf("ledger: %w", err)
	}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		var seen int
		if err := d.rw.QueryRowContext(ctx, "SELECT COUNT(*) FROM _migrations WHERE version=?", name).Scan(&seen); err != nil {
			return err
		}
		if seen > 0 {
			continue
		}
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := d.rw.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(sqlBytes)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO _migrations(version) VALUES(?)", name); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 5: Run — passes**

Run: `cd backend/nvr && go test ./internal/sqlitestore/ -run TestMigrateCreatesTablesIdempotent -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/nvr/internal/sqlitestore/migrate.go backend/nvr/internal/sqlitestore/migrations/
git commit -m "feat(nvr): SQLite migration runner + 0001_estate schema"
```

### Task 1.3: SQLite time/JSON helpers + `node_identity` repo

**Files:**
- Create: `backend/nvr/internal/sqlitestore/identity.go`
- Create: `backend/nvr/internal/sqlitestore/scan.go` (shared `toRFC3339`/`fromRFC3339`/`marshalJSON`/`scanJSON`)
- Test: `backend/nvr/internal/sqlitestore/identity_test.go`

- [ ] **Step 1: Write the failing test (upsert + get identity round-trips time)**

```go
func TestNodeIdentityRoundTrip(t *testing.T) {
	db, _ := Open(filepath.Join(t.TempDir(), "node.db"))
	defer db.Close()
	ctx := context.Background()
	db.Migrate(ctx)

	in := store.NodeIdentity{ID: "node-1", Name: "rack-a", EnrollState: "standalone", CreatedAt: time.Now().UTC().Truncate(time.Second)}
	if err := db.UpsertNodeIdentity(ctx, in); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := db.GetNodeIdentity(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ID != "node-1" || got.EnrollState != "standalone" || !got.CreatedAt.Equal(in.CreatedAt) {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}
```

- [ ] **Step 2: Run — fails**

Run: `cd backend/nvr && go test ./internal/sqlitestore/ -run TestNodeIdentityRoundTrip -v`
Expected: build error (`UpsertNodeIdentity` undefined).

- [ ] **Step 3: Write `scan.go` helpers + `identity.go`**

`scan.go`: `func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }`, `func parseRFC(s string) (time.Time, error)`, `nullRFC(*time.Time) any`, `func jsonText(v any) string`, `func scanJSON([]byte, any) error`. `identity.go`: `UpsertNodeIdentity` (single-row `INSERT ... ON CONFLICT(id) DO UPDATE`), `GetNodeIdentity` (first row). Add both methods to the `Store` interface.

- [ ] **Step 4: Run — passes**

Run: `cd backend/nvr && go test ./internal/sqlitestore/ -run TestNodeIdentityRoundTrip -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/nvr/internal/sqlitestore/scan.go backend/nvr/internal/sqlitestore/identity.go backend/nvr/internal/sqlitestore/identity_test.go backend/nvr/internal/store/store.go
git commit -m "feat(nvr): SQLite scan helpers + node_identity repo"
```

### Task 1.4: First-boot bootstrap (identity + secret key + bootstrap admin)

**Files:**
- Create: `backend/nvr/internal/identity/identity.go`
- Test: `backend/nvr/internal/identity/identity_test.go`

Implements spec §5.1. On empty `node.db`: generate node UUID + `secret_key_enc` root (from `VE_NODE_SECRET` or generated), create bootstrap admin `local_user` (argon2id via `gokernel`), write `node_identity`. Idempotent (no-op if identity already present).

- [ ] **Step 1: Failing test** — `Bootstrap(ctx, store, cfg)` on a fresh store creates one `node_identity` (state `standalone`) and one `local_user` with `is_bootstrap=1`; second call is a no-op. (Requires Task 4-phase local-user repo methods `CreateLocalUser`/`CountLocalUsers` — declare their signatures now and stub them in `localauth.go` returning `errNotImpl` until Phase 3, OR sequence this task after Task 3.1. **Sequencing note: move Task 1.4 to run immediately after Task 3.1.**)
- [ ] **Step 2–4:** implement `Bootstrap`, run test to pass.
- [ ] **Step 5: Commit** `feat(nvr): first-boot bootstrap (identity + secret root + admin)`.

---

## Phase 2 — Estate repos + repoint engines (behind `NVR_STORE=sqlite`)

### Task 2.1: Camera + media_profile repo

**Files:**
- Create: `backend/nvr/internal/sqlitestore/cameras.go`
- Test: `backend/nvr/internal/sqlitestore/cameras_test.go`

- [ ] **Step 1: Failing test (create → get-with-profiles → list → update → delete-cascade)**

```go
func TestCameraCRUDWithProfiles(t *testing.T) {
	db, _ := Open(filepath.Join(t.TempDir(), "node.db")); defer db.Close()
	ctx := context.Background(); db.Migrate(ctx)

	cam := store.Camera{ID: "c1", Name: "Ch 1", Status: "online", Brand: "onvif", RecordingMode: "continuous", RetentionDays: 30, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := db.CreateCamera(ctx, cam); err != nil { t.Fatal(err) }
	if err := db.UpsertMediaProfile(ctx, store.MediaProfile{ID: "p1", CameraID: "c1", Name: "sub", Codec: "H264", RTSPPath: "rtsp://x/sub"}); err != nil { t.Fatal(err) }

	got, err := db.GetCamera(ctx, "c1"); if err != nil { t.Fatal(err) }
	if got.Name != "Ch 1" || len(got.Profiles) != 1 { t.Fatalf("bad get: %+v", got) }

	list, _ := db.ListCameras(ctx, store.CameraFilter{})
	if len(list) != 1 { t.Fatalf("list=%d", len(list)) }

	got.RetentionDays = 60; db.UpdateCamera(ctx, got)
	again, _ := db.GetCamera(ctx, "c1")
	if again.RetentionDays != 60 { t.Fatalf("update lost") }

	db.DeleteCamera(ctx, "c1")
	if _, err := db.GetCamera(ctx, "c1"); err == nil { t.Fatalf("expected not-found") }
	// profile cascade-deleted
	profs, _ := db.ListMediaProfiles(ctx, "c1")
	if len(profs) != 0 { t.Fatalf("cascade failed") }
}
```

- [ ] **Step 2: Run — fails.** `cd backend/nvr && go test ./internal/sqlitestore/ -run TestCameraCRUDWithProfiles -v`
- [ ] **Step 3: Implement** `CreateCamera`, `GetCamera` (joins profiles), `ListCameras(filter)`, `UpdateCamera`, `DeleteCamera`, `UpsertMediaProfile`, `ListMediaProfiles`. Every column from spec §4.2/§4.3. JSON columns via `jsonText`/`scanJSON`; times via `rfc`/`parseRFC`. Add methods + `CameraFilter{Status,Name,SiteID,NvrID string}` to `Store`/`types.go`.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit** `feat(nvr): SQLite camera + media_profile repo`.

### Task 2.2–2.6: Remaining repos (one task each, same TDD shape as 2.1)

For each, write a CRUD round-trip test first, implement all columns from the cited spec section, add methods to `Store`, commit `feat(nvr): SQLite <x> repo`:

- **2.2 `nvrs.go`** — spec §4.4. `CreateNVR/GetNVR/ListNVRs/UpdateNVR/DeleteNVR`.
- **2.3 `recording.go`** — spec §4.5/§4.6. `ListRecordingTargets/UpsertRecordingTarget/DeleteRecordingTarget`, `UpsertRecordingSegment(returns inserted bool via ON CONFLICT(path) DO NOTHING + RowsAffected)`, `ListSegments(cameraID, from, to)`, `LockSegment/UnlockSegment`.
- **2.4 `storage.go`** — spec §4.7/§4.8/§4.9. Pool CRUD, tier-rule CRUD, `UpsertRaidArray/ListRaidArrays`.
- **2.5 `ptz.go`** — spec §4.10. Preset CRUD, patrol CRUD.
- **2.6 `shards.go` + `anr.go`** — spec §4.11/§4.12. `UpsertStreamShard/DeleteStreamShard/ListStreamShards`, `UpsertMediaNode/GetMediaNode`, `CreateAnrJob/UpdateAnrJob/ListAnrJobs/ClaimAnrJob`.

### Task 2.7: `pgstore` adapter (keep Postgres path working via the same interface)

**Files:**
- Create: `backend/nvr/internal/pgstore/pgstore.go`
- Modify: `backend/nvr/internal/{streams,recording,anr}/*.go` — change direct `*sql.DB` query calls to go through the `store.Store` methods they need.
- Test: existing `internal/anr` Postgres tests must still pass unchanged.

- [ ] **Step 1:** Implement `pgstore.New(db *sql.DB) store.Store` wrapping today's exact SQL for each `Store` method (move the current inline queries here — DRY: one place per query).
- [ ] **Step 2:** Refactor `streams`/`recording`/`anr` to accept a `store.Store` and call it instead of raw SQL. Keep behaviour identical.
- [ ] **Step 3: Run the full suite** `cd backend/nvr && go test ./...` — Expected: PASS (Postgres tests unchanged, SQLite tests green).
- [ ] **Step 4: Commit** `refactor(nvr): route engines through Store; add pgstore adapter`.

### Task 2.8: `main.go` — pick store by `NVR_STORE`, run migrations, bootstrap

**Files:**
- Modify: `backend/nvr/main.go`

- [ ] **Step 1:** Read `NVR_STORE` (default `postgres`). If `sqlite`: `Open(dataDir+"/node.db")` → `Migrate` → `identity.Bootstrap` → build `sqlitestore`. Else: connect Postgres as today → `pgstore.New`. Pass the chosen `store.Store` to `streams/recording/anr` mounts.
- [ ] **Step 2:** Guard: with `NVR_STORE` unset the boot path is byte-for-byte today's behaviour.
- [ ] **Step 3: Manual verify (both modes boot).** Postgres: `docker compose up -d nvr` (unchanged env) → `curl -s localhost/api/v1/nvr/status` via gateway = 200. SQLite: run locally `NVR_STORE=sqlite VE_NODE_SECRET=dev VE_NODE_ADMIN_PASSWORD=dev go run .` → logs show migrations applied + bootstrap admin created; `GET /health` = 200.
- [ ] **Step 4: Commit** `feat(nvr): select store backend via NVR_STORE (sqlite = autonomous node)`.

---

## Phase 3 — Local auth + dual-mode middleware + enrollment

### Task 3.1: Local users + sessions repo + argon2 service

**Files:**
- Create: `backend/nvr/internal/sqlitestore/localauth.go` (repo: `CreateLocalUser/GetLocalUserByName/CountLocalUsers/UpdateLocalUser`, `CreateSession/GetSessionByTokenHash/RevokeSession`)
- Create: `backend/nvr/internal/localauth/service.go` (login → verify argon2 via `gokernel` hasher → mint opaque token, store sha256; logout; lockout on `failed_login_count`)
- Test: `backend/nvr/internal/localauth/service_test.go`

- [ ] **Step 1: Failing test** — create admin, `Login("admin","dev")` returns a token; `ResolveSession(token)` returns the user; wrong password increments `failed_login_count` and after N locks `locked_until`.
- [ ] **Steps 2–4:** implement, pass. Reuse `gokernel`'s argon2id hasher (find it: `grep -rn "argon2" backend/gokernel`); do NOT hand-roll hashing.
- [ ] **Step 5: Commit** `feat(nvr): local users/sessions + argon2 login service`.

*(After this task, return to Task 1.4 and implement bootstrap; run its test.)*

### Task 3.2: Dual-mode auth middleware → unified `Caller`

**Files:**
- Create: `backend/nvr/internal/localauth/middleware.go`
- Test: `backend/nvr/internal/localauth/middleware_test.go`

Implements spec §5.4. One `func Authenticate(next http.Handler) http.Handler` that tries, in order: local session (opaque bearer in `local_sessions`) → central JWT (`gokernel/auth` verifier) → node credential (`X-Node-Credential`). Populates `Caller{Kind, Subject, Perms}` in context. `RequirePerm("vms.camera.read")` helper maps central perms + local roles (admin⊇operator⊇viewer).

- [ ] **Step 1: Failing test** — a request with a valid local session passes and yields `Caller{Kind:"local"}`; a valid central JWT yields `Caller{Kind:"central"}`; no creds → 401; a media token (`sub_type:"media"`) → 401 on the management API.
- [ ] **Steps 2–4:** implement, pass.
- [ ] **Step 5: Commit** `feat(nvr): dual-mode auth middleware (local/central/node)`.

### Task 3.3: Enrollment client (join-token → node credential)

**Files:**
- Create: `backend/nvr/internal/identity/enroll.go`
- Test: `backend/nvr/internal/identity/enroll_test.go` (mock central via `httptest.Server`)

Implements spec §5.2. `Enroll(ctx, store, joinToken)`: POST to `{central}/api/v1/vms/nodes/enroll` with `{join_token, node_id, hostname, version, mediamtx_endpoints}`; on 200 persist `node_credential` (encrypted), `jwt_public_key`, reconciled `id`, `central_base_url`, `enroll_state='enrolled'`. Handle expired/replayed token (central returns 409/401) → surface error, stay `standalone`.

- [ ] **Step 1: Failing test** — mock central returns a credential+anchor; after `Enroll` the stored identity is `enrolled` with an encrypted credential; a 401 from central leaves state `standalone`.
- [ ] **Steps 2–4:** implement, pass.
- [ ] **Step 5: Commit** `feat(nvr): node enrollment client (join-token exchange)`.

---

## Phase 4 — Estate API (`/api/v1/nvr/estate/*`)

> Every handler: dual-auth (Task 3.2), reads/writes via `store.Store`, emits an `audit_log` row on writes (add `db.AppendAudit(ctx, AuditEntry{...})` in Task 4.0), returns `httpx.JSON`. Follow `vision/app/vms/cameras/router.py` for request/response shapes so the frontend `features/vms/api.js` works against the node with only a base-URL change.

### Task 4.0: audit repo + estate router skeleton + mount

**Files:**
- Create: `backend/nvr/internal/sqlitestore/audit.go` (`AppendAudit`, `ListAudit`)
- Create: `backend/nvr/internal/estate/router.go` (`func Mount(r chi.Router, deps Deps)` under `/api/v1/nvr/estate`, wrapped in `localauth.Authenticate`)
- Modify: `backend/nvr/main.go` (mount estate router only when `NVR_STORE=sqlite`)
- Test: `backend/nvr/internal/estate/router_test.go` (a `GET /estate/node` with a local session → 200; without creds → 401)

- [ ] Steps: failing test → implement `Deps{Store, MediaToken, Identity, Fed}` + mount + `/estate/node` + `/estate/health` handlers → pass → commit `feat(nvr): estate router + audit + node self endpoints`.

### Task 4.1: Camera handlers

**Files:**
- Create: `backend/nvr/internal/estate/cameras.go`
- Test: `backend/nvr/internal/estate/cameras_test.go`

Endpoints from spec §6.1 "Cameras": list/create/get/patch/delete/bulk/reorder + advanced-config GET/PUT (motion-config, privacy-masks, motion-zones, onvif-events) + snapshot + apply-stream-policy. Create supports optional device probe (call the driver seam — Task 4.5).

- [ ] **Step 1: Failing test** — `POST /estate/cameras {name,onvif_host,...}` → 201 with an id; `GET /estate/cameras` includes it; `PATCH` retention → 200 and persisted; `DELETE` → 204 then `GET` 404. Assert an `audit_log` row exists for the create.
- [ ] **Steps 2–4:** implement over the camera repo, pass.
- [ ] **Step 5: Commit** `feat(nvr): estate camera handlers`.

### Task 4.2–4.4: nvrs / recording-config / storage+raid / ptz handlers

One task each (same shape as 4.1), endpoints per spec §6.1:
- **4.2 `nvrs.go`** — NVR CRUD.
- **4.3 `recording.go`** — `GET|PUT /cameras/{id}/recording` (writes camera recording fields → recording-supervisor reconciles), `recording/start|stop`.
- **4.4 `storage.go`** — pool CRUD + `pools/{id}/test`, tier-rule CRUD, `GET /storage/raid`. **`ptz.go`** — preset/patrol CRUD + `goto`/`move`/`start`/`stop`.

Each: failing CRUD/action test → implement → pass → commit.

### Task 4.5: Driver seam for discovery/probe/snapshot

**Files:**
- Create: `backend/nvr/internal/estate/driver.go` (interface `Driver{ Discover, Probe, Channels, Snapshot }`)
- Decision (spec §6.1 note, §10.5): implement a **driver sidecar client** first — the node calls the existing Python `vision` driver endpoints IF reachable, else returns a graceful "driver unavailable" (never 500). A Go-native ONVIF client is a follow-up. Wire `/estate/discover|probe|channels|bulk-add`.
- Test: mock sidecar via `httptest`; unreachable sidecar → endpoints return 200 with empty result + a `driver_unavailable` flag, not 500.

- [ ] Steps: failing test → implement client + graceful degrade → pass → commit `feat(nvr): estate discovery/probe via driver seam`.

---

## Phase 5 — Node-issued media tokens + live/playback

### Task 5.1: Media token mint + verify

**Files:**
- Create: `backend/nvr/internal/mediatoken/mediatoken.go`
- Test: `backend/nvr/internal/mediatoken/mediatoken_test.go`

Implements spec §5.5. Claim shape identical to `vision/app/vms/common/media_token.py` (`sub_type:"media", tenant_id, camera_id, session_id, mode, iat, exp`), HS256 signed with the node's anchor (enrollment-shared secret when enrolled, else node-local key). `Mint(camera, mode, ttl)` + `Verify(token)` (single HMAC, no DB).

- [ ] **Step 1: Failing test** — `Verify(Mint(...))` returns the claims; a token signed with a different key fails; an expired token fails.
- [ ] **Steps 2–4:** implement, pass.
- [ ] **Step 5: Commit** `feat(nvr): node-issued media tokens (mint + verify)`.

### Task 5.2: `/media/verify` (MediaMTX ForwardAuth) + live/playback estate endpoints

**Files:**
- Create: `backend/nvr/internal/estate/live.go`
- Modify: `deploy/mediamtx.yml` (point ForwardAuth at the node's `/api/v1/nvr/media/verify` when `NVR_STORE=sqlite`) — document only; do not change the running Postgres deployment's config.
- Test: `backend/nvr/internal/estate/live_test.go`

Endpoints (spec §6.1 "Live / playback"): `POST /estate/cameras/{id}/live` + `/playback` (mint token, ensure MediaMTX path via existing `streams` package, return HLS/WHEP URLs), `GET /estate/recordings` (from `recording_segments`), `GET /media/verify` (hot path → `mediatoken.Verify`).

- [ ] **Step 1: Failing test** — `POST /estate/cameras/{id}/live` returns URLs + a token that `GET /media/verify?...` accepts; a tampered token → 401.
- [ ] **Steps 2–4:** implement, pass.
- [ ] **Step 5: Commit** `feat(nvr): node live/playback + media/verify ForwardAuth`.

---

## Phase 6 — Federation node-side (stubbed behind `FEDERATION_ENABLED=false`)

### Task 6.1: Outbound queue + drainer

**Files:** `backend/nvr/internal/sqlitestore/outbound.go` (`EnqueueOutbound/NextOutbound/DeleteOutbound/BackoffOutbound`), `backend/nvr/internal/federation/outboundq.go` (drainer goroutine).
- [ ] Failing test: enqueue 3 → drainer with a mock sink delivers oldest-first + deletes; a failing sink backs off via `next_try_at`. Implement → pass → commit `feat(nvr): federation outbound queue + drainer`.

### Task 6.2: Snapshot builder + heartbeat loop

**Files:** `backend/nvr/internal/federation/snapshot.go` (versioned estate doc + content hash), `heartbeat.go` (loop; light payload per spec §7.2). Enqueue snapshot on any estate write (debounced) + periodically.
- [ ] Failing test: `BuildSnapshot(store)` returns a doc whose `snapshot_version` increments and whose hash changes when a camera is added. Implement → pass → commit `feat(nvr): estate snapshot builder + heartbeat`.

### Task 6.3: Override-accept endpoint

**Files:** `backend/nvr/internal/federation/override.go` + route `POST /api/v1/nvr/estate/override`.
Implements spec §7.3: persist fields as new truth → `audit_log action=override.accept` → bump snapshot_version → enqueue fresh snapshot.
- [ ] Failing test: override sets a camera's retention → persisted; audit row written; a later local PATCH wins over the stale central value. Implement → pass → commit `feat(nvr): federation override-accept`.

### Task 6.4: Federation config gate + wiring

**Files:** `backend/nvr/internal/federation/federation.go`, `main.go`.
`FEDERATION_ENABLED` (default false). When false: queue/drainer/heartbeat still run locally but the central sink is a no-op logger (endpoints 404 until SP3); the node is pure-standalone. When true: sink posts to `central_base_url`.
- [ ] Failing test: with the flag false, estate writes enqueue but the drainer no-ops without error; node operation is unaffected. Implement → pass → commit `feat(nvr): FEDERATION_ENABLED gate (SP1 pure-standalone default)`.

---

## Phase 7 — Migration import endpoint (node side; central tool is SP3)

### Task 7.1: `POST /api/v1/nvr/estate/import`

**Files:** `backend/nvr/internal/estate/node.go` (import handler, node-credential auth only), reuses repos.
Implements spec §8.2 step 3: accept a migration bundle (cameras/profiles/segments/pools/tier-rules/ptz/targets/shards/anr), **upsert-by-id** (idempotent, preserve UUIDs), **re-wrap** `enc:` fields from the bundle key to the node key (`crypto` re-encrypt — reuse the node secret root). Return the post-import estate snapshot for the tool's diff.

- [ ] **Step 1: Failing test** — import a bundle with 2 cameras + profiles → rows exist with same ids; re-import = no dupes (upsert); an `enc:` field decrypts under the node key afterward; response contains a snapshot whose camera ids match the bundle.
- [ ] **Steps 2–4:** implement, pass.
- [ ] **Step 5: Commit** `feat(nvr): estate import endpoint (SP3 migration target)`.

---

## Phase 8 — Standalone integration test + docs

### Task 8.1: Headline standalone test (spec §9.1)

**Files:** `backend/nvr/internal/estate/standalone_test.go`

- [ ] **Step 1: Write the integration test** — boot the store with a temp `node.db`, `FEDERATION_ENABLED=false`, no Postgres, no network: migrate → bootstrap admin → login → `POST /estate/cameras` → recording target created → `UpsertRecordingSegment` indexes a fake segment → `GET /estate/recordings` returns it → `POST /estate/cameras/{id}/live` mints a token that `/media/verify` accepts → storage pool + ptz preset CRUD succeed. This is the "self-sufficient mini-VMS" proof.
- [ ] **Step 2: Run — passes.** `cd backend/nvr && go test ./internal/estate/ -run TestStandalone -v`
- [ ] **Step 3: Commit** `test(nvr): headline standalone integration test`.

### Task 8.2: Docs

**Files:** Modify `backend/nvr/README.md` (+ a short `docs/NODE_AGENT.md`): how to boot a node standalone (`NVR_STORE=sqlite`, env vars `VE_NODE_SECRET`/`VE_NODE_ADMIN_*`/`VE_NODE_JOIN_TOKEN`), the `/estate/*` surface, and the SP2/SP3 seams.
- [ ] Steps: write docs → commit `docs(nvr): node agent standalone operation`.

---

## Self-review (completed against the spec)

- **Spec coverage:** §4 tables → Phase 1–2 (each table has a repo task); §5 identity/enroll/auth/media → Phase 1.4/3/5; §6 API → Phase 4–5; §7 federation → Phase 6; §8 migration → Phase 7; §9 tests → per-task + Phase 8. No section unmapped.
- **Sequencing fix:** Task 1.4 (bootstrap) depends on Task 3.1 (local-user repo) — flagged inline; execute 3.1 before 1.4.
- **Placeholder scan:** foundational/novel tasks (0–3) carry full code; repetitive CRUD tasks (2.2–2.6, 4.2–4.4) cite exact spec sections + the shared helpers/interface defined in earlier tasks (DRY reuse, not placeholders) — the executor writes each column set from the named spec section.
- **Type consistency:** `store.Store` methods introduced per phase are the single source; handlers and federation call only those. `Caller`, `Deps`, `CameraFilter`, media-claim shape are each defined once and reused by name.
- **Non-destructive guarantee:** `NVR_STORE=postgres` (default) + `FEDERATION_ENABLED=false` (default) = today's behaviour; the live-NVR demo is unaffected until a deliberate `sqlite` cutover.
