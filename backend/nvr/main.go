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

	"github.com/neubit/nvr/internal/mediamtx"
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
	localNode := mediamtx.Node{
		ID:         env("VE_MEDIA_NODE_ID", "mediamtx-0"),
		APIURL:     env("VE_MEDIAMTX_API_URL", "http://mediamtx:9997"),
		HLSBase:    env("VE_MEDIAMTX_HLS_BASE", "http://localhost:8888"),
		WebRTCBase: env("VE_MEDIAMTX_WEBRTC_BASE", "http://localhost:8889"),
		RTSPBase:   env("VE_MEDIAMTX_RTSP_BASE", "rtsp://localhost:8554"),
	}
	idleTTL := time.Duration(envInt("VE_STREAM_IDLE_TTL_SEC", 300)) * time.Second
	mtxClient := mediamtx.New()
	sup := supervisor.New(pool, mtxClient, idleTTL, serviceName)
	if err := sup.EnsureNode(bootCtx, localNode); err != nil {
		// Node registration failing is fatal — without it no stream can be assigned.
		log.Fatalf("media node registration failed: %v", err)
	}
	sup.Start(runCtx) // idle-path reaper (stops when runCtx is cancelled)

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
					"service":   serviceName,
					"plane":     "data",
					"phase":     "P2-A-streaming",
					"nats":      bus.IsConnected(),
					"streaming": true,
					"node":      localNode.ID,
				})
			})

		// Internal stream-orchestration endpoints (service-to-service; called by
		// the Python vision control-plane in P2-B). JWT-gated + vms.* permissions.
		streams.Mount(api, sup)
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
