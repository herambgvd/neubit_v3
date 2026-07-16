// Command nvr is the VMS data-plane service (Go) — the first Go service in
// neubit_v3. It is built on the shared gokernel so it interoperates with the
// Python control-plane services (core/vision) over the SAME JWT, NATS envelope
// and error contracts.
//
// P1 is a SCAFFOLD ONLY: boot, load config, connect its own DB (neubit_nvr) +
// run the baseline migration, connect NATS, and serve a JWT-verified HTTP API
// with a public /health. The heavy streaming/recording/sharding work (RTSP pull
// supervision, MediaMTX/ffmpeg drive, ONVIF PullPoint ingestion → NATS) lands in
// P2–P3.
//
// Run:  go run .    (env: VE_DATABASE_URL→neubit_nvr, VE_NATS_URL, VE_JWT_SECRET)
package main

import (
	"context"
	"embed"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/neubit/gokernel/auth"
	"github.com/neubit/gokernel/config"
	"github.com/neubit/gokernel/db"
	"github.com/neubit/gokernel/events"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/anr"
	"github.com/neubit/nvr/internal/estate"
	"github.com/neubit/nvr/internal/identity"
	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/mediamtx"
	"github.com/neubit/nvr/internal/playback"
	"github.com/neubit/nvr/internal/recording"
	"github.com/neubit/nvr/internal/sqlitestore"
	"github.com/neubit/nvr/internal/streams"
	"github.com/neubit/nvr/internal/supervisor"
	"github.com/neubit/nvr/webui"
)

const serviceName = "nvr"

//go:embed migrations/*.sql
var migrationsFS embed.FS

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[nvr] ")

	cfg := config.Load()
	cfg.AppName = serviceName

	// Long-lived context for the service (reaper, background loops); a short child
	// is used for the boot-time DB connect + migration.
	runCtx, stop := context.WithCancel(context.Background())
	defer stop()

	bootCtx, cancel := context.WithTimeout(runCtx, 30*time.Second)
	defer cancel()

	// --- Store backend selection (NVR_STORE) ------------------------------------
	// "postgres" (default): central mode — connect this service's own database
	// (neubit_nvr), run its baseline migration, and drive the streaming/recording/
	// ANR engines against the pool exactly as today. With NVR_STORE unset the boot
	// path below is byte-for-byte the historical behaviour.
	//
	// "sqlite": autonomous-node mode — open the embedded SQLite estate (node.db) in
	// this binary (no external DB process), migrate it, and first-boot bootstrap a
	// node identity + crypto root + login-able admin. The pgx-bound engines are not
	// started in this mode (they are repointed to the node store in a later phase),
	// so the node comes up store-ready and serves its JWT-gated API + health.
	storeBackend := env("NVR_STORE", "postgres")

	if storeBackend == "sqlite" {
		runSQLiteNode(runCtx, bootCtx, cfg)
		return
	}

	// --- DB: this service's OWN database (neubit_nvr) + baseline migration -----
	pool, err := db.Connect(bootCtx, cfg.NormalizedDSN())
	if err != nil {
		log.Fatalf("database connect failed: %v", err)
	}
	defer pool.Close()

	applied, err := db.Migrate(bootCtx, pool, migrationsFS, "migrations")
	if err != nil {
		log.Fatalf("migration failed: %v", err)
	}
	if len(applied) > 0 {
		log.Printf("migrations applied: %v", applied)
	} else {
		log.Printf("migrations up to date")
	}

	// --- NATS event spine (shared envelope/subject with the Python services) ---
	bus := events.NewBus(serviceName, cfg.NATSURL)
	if err := bus.Connect(); err != nil {
		log.Fatalf("nats connect failed: %v", err)
	}
	defer bus.Close()
	// Announce startup on the same spine the Python services use.
	_ = bus.Publish(events.Subject(nil, serviceName, "startup"), map[string]any{"service": serviceName})

	// --- Stream orchestration (P2-A): MediaMTX client + stream-supervisor -------
	// The supervisor owns the media-node registry + camera→node shards (own DB)
	// and drives MediaMTX path provisioning. In P2 nvr registers its single local
	// node from env; multi-node registration is the same call per node in P6.
	// APIURL is the INTERNAL MediaMTX control API (nvr-only). The public HLS/WHEP
	// bases are browser-facing and, from P2-C, point at the Traefik GATEWAY prefix
	// (not MediaMTX :8888/:8889 direct) so playback is token-gated by the media-auth
	// ForwardAuth. HLSURL/WHEPURL append `/<name>/index.m3u8` + `/<name>/whep`, so a
	// base of `http://localhost/media/hls` yields `.../media/hls/<name>/index.m3u8`,
	// which the gateway strips to `/<name>/index.m3u8` for MediaMTX. The legacy
	// VE_MEDIAMTX_{HLS,WEBRTC}_BASE vars remain a fallback for direct (un-gated)
	// access in tests. RTSP stays direct (service-to-service, not browser-facing).
	localNode := mediamtx.Node{
		ID:     env("VE_MEDIA_NODE_ID", "mediamtx-0"),
		APIURL: env("VE_MEDIAMTX_API_URL", "http://mediamtx:9997"),
		HLSBase: env("VE_MEDIA_PUBLIC_HLS_BASE",
			env("VE_MEDIAMTX_HLS_BASE", "http://localhost/media/hls")),
		WebRTCBase: env("VE_MEDIA_PUBLIC_WHEP_BASE",
			env("VE_MEDIAMTX_WEBRTC_BASE", "http://localhost/media/whep")),
		RTSPBase: env("VE_MEDIAMTX_RTSP_BASE", "rtsp://localhost:8554"),
		// Recorded playback (P4-A). PlaybackAPIURL is the INTERNAL MediaMTX
		// playback server (nvr queries /list here). PlaybackBase is browser-facing
		// and points at the Traefik GATEWAY prefix so recorded fmp4 is token-gated
		// by the same media-auth ForwardAuth as live (never the raw :9996 port).
		PlaybackAPIURL: env("VE_MEDIAMTX_PLAYBACK_API_URL", "http://mediamtx:9996"),
		PlaybackBase: env("VE_MEDIA_PUBLIC_PLAYBACK_BASE",
			env("VE_MEDIAMTX_PLAYBACK_BASE", "http://localhost/media/playback")),
	}
	idleTTL := time.Duration(envInt("VE_STREAM_IDLE_TTL_SEC", 300)) * time.Second
	mtxClient := mediamtx.New()
	sup := supervisor.New(pool, mtxClient, idleTTL, serviceName)
	if err := sup.EnsureNode(bootCtx, localNode); err != nil {
		// Node registration failing is fatal — without it no stream can be assigned.
		log.Fatalf("media node registration failed: %v", err)
	}
	sup.Start(runCtx) // idle-path reaper (stops when runCtx is cancelled)

	// --- Recording engine (P3-A): recording-supervisor + segment-tracker --------
	// Drives MediaMTX native recording (record=yes on the path → fmp4 segments to
	// the mounted `recordings` volume), reconciles desired-vs-actual on a tick, and
	// emits tenant.<id>.vms.recording.segment as segments finalize → vision persists
	// Recording rows. Shares the stream-supervisor's node registry + MediaMTX client.
	recSup := recording.New(pool, mtxClient, sup, bus, serviceName, recording.Config{
		Dir:             env("VE_RECORDINGS_DIR", "/recordings"),
		SegmentDuration: env("VE_RECORD_SEGMENT_DURATION", "60s"),
		Tick:            time.Duration(envInt("VE_RECORD_TICK_SEC", 15)) * time.Second,
	})
	recSup.Start(runCtx)

	// --- Recording resilience (P6-A) --------------------------------------------
	// 1. Node heartbeat monitor + rebalance-on-node-loss: the stream-supervisor
	//    probes each media node's control API (refreshing live heartbeats) and marks
	//    a node dead after VE_NODE_DEAD_SEC of silence, reassigning its shards +
	//    re-enabling record on the survivor. The recording-supervisor registers its
	//    rebind hook so recording resumes on the new node without a control-plane call.
	sup.SetRecordRebinder(recSup)
	sup.StartHealthMonitor(runCtx,
		time.Duration(envInt("VE_NODE_HEARTBEAT_SEC", 15))*time.Second,
		time.Duration(envInt("VE_NODE_DEAD_SEC", 45))*time.Second,
	)

	// 2. ANR (edge-recording backfill): detect a recording gap for a reconnected,
	//    continuously-recording camera → open an ANRJob → publish an anr.request a
	//    vision worker fulfils from the edge (it holds the device creds + P4-B footage
	//    search); the pulled segments land on the shared recordings volume + flow
	//    through the segment tracker → Recording rows. vision's anr.result closes the
	//    job. (See internal/anr for the nvr↔vision split rationale.)
	anrEngine := anr.New(pool, bus, serviceName, anr.Config{
		MinGap: time.Duration(envInt("VE_ANR_MIN_GAP_SEC", 120)) * time.Second,
		MaxGap: time.Duration(envInt("VE_ANR_MAX_GAP_HOURS", 24)) * time.Hour,
		Tick:   time.Duration(envInt("VE_ANR_TICK_SEC", 30)) * time.Second,
	})
	anrEngine.Start(runCtx)
	// Close jobs on the vision fulfiller's result. Durable so a redelivery after an
	// nvr restart still lands (CloseJob is idempotent). No-op when NATS is disabled.
	if err := bus.Subscribe("tenant.*.vms.anr.result", anrEngine.HandleResult, "nvr-anr-results"); err != nil {
		log.Printf("anr result subscribe note: %v", err)
	}

	// --- HTTP: chi + shared middleware; /health public, /api/v1/nvr JWT-gated --
	verifier := auth.NewVerifier(cfg.JWTSecret)
	r := httpx.NewRouter(cfg)

	// Public health (never JWT-gated), matching the Python services' shape.
	httpx.Health(r, serviceName, cfg.Env)

	// Versioned, JWT-verified API. Even the whoami proof requires a valid token,
	// so 401-without-token is demonstrable on the very first route.
	r.Route(cfg.APIPrefix+"/nvr", func(api chi.Router) {
		api.Use(httpx.RequireAuth(verifier))
		// The whole NVR data-plane is the tenant's "vms" module + needs an unexpired
		// license (super-admins bypass both). Module off → 403 FEATURE_DISABLED;
		// past-grace license → 403 LICENSE_EXPIRED. Mirrors the Python vision gate.
		api.Use(httpx.RequireFeature("vms"))
		api.Use(httpx.RequireActiveLicense())

		// whoami — proves cross-language JWT verification (a core-minted token
		// verifies here identically to the Python vision service).
		api.Get("/whoami", func(w http.ResponseWriter, req *http.Request) {
			p, ok := httpx.MustPrincipal(w, req)
			if !ok {
				return
			}
			var tid any
			if p.TenantID != nil {
				tid = p.TenantID.String()
			}
			httpx.JSON(w, http.StatusOK, map[string]any{
				"user_id":       p.UserID.String(),
				"tenant_id":     tid,
				"is_superadmin": p.IsSuperadmin,
				"permissions":   p.Permissions,
				"service":       serviceName,
			})
		})

		// Data-plane health/status — gated by the vms.* permission catalog.
		api.With(httpx.RequirePermission("vms.camera.read")).
			Get("/status", func(w http.ResponseWriter, _ *http.Request) {
				httpx.JSON(w, http.StatusOK, map[string]any{
					"service":    serviceName,
					"plane":      "data",
					"phase":      "P6-A-resilience",
					"nats":       bus.IsConnected(),
					"streaming":  true,
					"recording":  true,
					"resilience": true, // heartbeat/rebalance + redundant record + ANR
					"node":       localNode.ID,
				})
			})

		// Internal stream-orchestration endpoints (service-to-service; called by
		// the Python vision control-plane in P2-B). JWT-gated + vms.* permissions.
		streams.Mount(api, sup)

		// Internal recording endpoints (service-to-service; called by vision in
		// P3-A). start/stop drive MediaMTX record; status lists active recordings.
		recording.Mount(api, recSup)

		// Internal recorded-playback endpoint (service-to-service; called by vision
		// in P4-A). Resolves the camera's node, lists recorded ranges from the
		// MediaMTX playback server, and builds the gateway-routed /get URL.
		playback.Mount(api, sup, mtxClient)

		// Internal ANR endpoints (P6-A): list backfill jobs + force gap-detection
		// for a reconnected camera. The actual edge pull is fulfilled by a vision
		// worker over the anr.request/anr.result NATS pair.
		anr.Mount(api, anrEngine)
	})

	addr := ":" + strconv.Itoa(cfg.Port)
	log.Printf("listening on %s (env=%s)", addr, cfg.Env)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("http server: %v", err)
	}
}

// runSQLiteNode boots the service in autonomous-node mode (NVR_STORE=sqlite): the
// full estate lives in an embedded SQLite file opened inside this binary — no
// external Postgres, no central contact required. It migrates the estate, runs the
// first-boot bootstrap (node identity + crypto root + login-able admin), and serves
// the JWT-gated API + public health. The pgx-bound streaming/recording/ANR engines
// are NOT started here; they are repointed to the node store in a later phase, so
// the node comes up store-ready. This path is only reached with NVR_STORE=sqlite —
// the default postgres boot in main() is untouched.
func runSQLiteNode(runCtx, bootCtx context.Context, cfg *config.Settings) {
	// --- Embedded SQLite estate (node.db) + migration ---------------------------
	dbPath := env("VE_NODE_DB_PATH", "/data/node.db")
	if dir := filepath.Dir(dbPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			log.Fatalf("node db dir %q: %v", dir, err)
		}
	}
	nodeStore, err := sqlitestore.Open(dbPath)
	if err != nil {
		log.Fatalf("sqlite open %q: %v", dbPath, err)
	}
	defer nodeStore.Close()

	if err := nodeStore.Migrate(bootCtx); err != nil {
		log.Fatalf("sqlite migration failed: %v", err)
	}
	log.Printf("sqlite estate ready at %s", dbPath)

	// --- First-boot bootstrap (identity + secret root + bootstrap admin) --------
	res, err := identity.Bootstrap(bootCtx, nodeStore, identity.Config{
		NodeName:      env("VE_NODE_NAME", ""),
		NodeSecret:    env("VE_NODE_SECRET", ""),
		AdminUser:     env("VE_NODE_ADMIN_USER", ""),
		AdminPassword: env("VE_NODE_ADMIN_PASSWORD", ""),
	})
	if err != nil {
		log.Fatalf("node bootstrap failed: %v", err)
	}
	if res.AlreadyBootstrapped {
		log.Printf("node already bootstrapped: id=%s name=%q state=%s",
			res.Identity.ID, res.Identity.Name, res.Identity.EnrollState)
	} else {
		log.Printf("node bootstrapped: id=%s name=%q state=%s",
			res.Identity.ID, res.Identity.Name, res.Identity.EnrollState)
		// Surface generated secrets ONCE so the installer can capture them; they are
		// never persisted in plaintext beyond this line.
		if res.GeneratedNodeSecret != "" {
			log.Printf("generated bootstrap node secret: %s", res.GeneratedNodeSecret)
		}
		if res.GeneratedAdminPassword != "" {
			log.Printf("generated bootstrap admin password: %s", res.GeneratedAdminPassword)
		}
	}

	// --- NATS event spine (best-effort; a standalone node runs without it) -------
	bus := events.NewBus(serviceName, cfg.NATSURL)
	if err := bus.Connect(); err != nil {
		log.Printf("nats connect note (standalone continues without it): %v", err)
	} else {
		defer bus.Close()
		_ = bus.Publish(events.Subject(nil, serviceName, "startup"), map[string]any{"service": serviceName, "mode": "node"})
	}

	// --- Local auth (standalone-console login over the node's own users) --------
	// The estate API authenticates local sessions through this service; it also
	// backs the /estate/auth/login|logout endpoints in a later stage.
	localAuth := localauth.NewService(nodeStore, localauth.Config{})

	// --- HTTP: chi + shared middleware; /health public, /api/v1/nvr JWT-gated ----
	verifier := auth.NewVerifier(cfg.JWTSecret)
	r := httpx.NewRouter(cfg)
	httpx.Health(r, serviceName, cfg.Env)

	r.Route(cfg.APIPrefix+"/nvr", func(api chi.Router) {
		// Estate management API (/api/v1/nvr/estate/*) — node-authoritative CRUD over
		// the embedded SQLite estate, behind its OWN dual-mode auth (local session /
		// central JWT / node credential; estate.Mount adds the /estate prefix and
		// applies localauth.Authenticate). Mounted here, OUTSIDE the central-JWT
		// Group below, so a standalone local session (no central token) can drive it.
		// This whole path only exists in sqlite mode; the postgres boot in main()
		// never reaches it.
		estateDeps := &estate.Deps{
			DB:       nodeStore,
			Auth:     localAuth,
			NodeName: res.Identity.Name,
		}
		estate.Mount(api, estateDeps)

		// PUBLIC media-plane routes (/api/v1/nvr/media/verify) — the MediaMTX
		// ForwardAuth hot path. Mounted OUTSIDE estate.Mount's auth middleware
		// because it authorises off the stateless media token alone (no session /
		// bearer, no DB); the estate Authenticator rejects media tokens by design.
		estate.MountPublic(api, estateDeps)

		// The existing internal /nvr/* endpoints stay gated by the central JWT +
		// vms feature/license, scoped to this Group so the estate mount above is
		// unaffected.
		api.Group(func(api chi.Router) {
			api.Use(httpx.RequireAuth(verifier))
			api.Use(httpx.RequireFeature("vms"))
			api.Use(httpx.RequireActiveLicense())

			api.Get("/whoami", func(w http.ResponseWriter, req *http.Request) {
				p, ok := httpx.MustPrincipal(w, req)
				if !ok {
					return
				}
				var tid any
				if p.TenantID != nil {
					tid = p.TenantID.String()
				}
				httpx.JSON(w, http.StatusOK, map[string]any{
					"user_id":       p.UserID.String(),
					"tenant_id":     tid,
					"is_superadmin": p.IsSuperadmin,
					"permissions":   p.Permissions,
					"service":       serviceName,
				})
			})

			api.With(httpx.RequirePermission("vms.camera.read")).
				Get("/status", func(w http.ResponseWriter, _ *http.Request) {
					httpx.JSON(w, http.StatusOK, map[string]any{
						"service": serviceName,
						"plane":   "data",
						"phase":   "node-agent-core",
						"store":   "sqlite",
						"nats":    bus.IsConnected(),
						"node":    res.Identity.ID,
					})
				})
		})
	})

	// --- Box-served web UI (embedded static SPA) --------------------------------
	// Only in autonomous-node mode does this binary also serve the operator console:
	// the built Vite/React SPA is embedded (webui.Handler) and mounted at the site
	// root with an index.html SPA fallback. It is registered AFTER the /api/v1/nvr
	// routes + public /health above, so those keep their handlers and only unmatched
	// (client-side route) paths fall through to the UI. The postgres boot in main()
	// never mounts it — central mode has no box-local UI.
	r.Mount("/", webui.Handler())

	addr := ":" + strconv.Itoa(cfg.Port)
	log.Printf("listening on %s (env=%s, store=sqlite)", addr, cfg.Env)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}
	// Stop serving when the run context is cancelled (parity with main()).
	go func() {
		<-runCtx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("http server: %v", err)
	}
}

// env reads a VE_* var with a default (config.Load handles the shared kernel
// fields; these media-node vars are nvr-specific, so read them directly here).
func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
