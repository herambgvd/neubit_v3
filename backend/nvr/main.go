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
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/neubit/gokernel/auth"
	"github.com/neubit/gokernel/config"
	"github.com/neubit/gokernel/db"
	"github.com/neubit/gokernel/events"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/anr"
	"github.com/neubit/nvr/internal/mediamtx"
	"github.com/neubit/nvr/internal/playback"
	"github.com/neubit/nvr/internal/recording"
	"github.com/neubit/nvr/internal/streams"
	"github.com/neubit/nvr/internal/supervisor"
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
