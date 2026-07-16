// Package estate serves the node-authoritative estate-management API
// (/api/v1/nvr/estate/*, spec §6.1). It runs ONLY in autonomous-node mode
// (NVR_STORE=sqlite): every handler reads/writes the concrete embedded SQLite
// store (*sqlitestore.DB), authenticates via the dual-mode middleware
// (localauth.Authenticate — local session / central JWT / node credential), and
// records an audit_log row on writes. The same request/response shapes mirror the
// central control plane (vision/app/vms/cameras) so the frontend API client works
// against a node with only a base-URL change.
package estate

import (
	"github.com/go-chi/chi/v5"

	"github.com/neubit/nvr/internal/localauth"
	"github.com/neubit/nvr/internal/sqlitestore"
)

// Deps are the concrete dependencies the estate handlers need. DB is the concrete
// SQLite store (not the store.Store seam) because the estate + audit methods live
// only on the node backend — the postgres path never mounts this router.
type Deps struct {
	DB       *sqlitestore.DB    // node-authoritative estate + audit
	Auth     *localauth.Service // local-session resolver (login/logout) — room to grow
	NodeName string             // node display name (env VE_NODE_NAME), for health/self
	// Room to grow: MediaToken minter, federation wiring, driver seam (later stages).
}

// Mount wires the estate sub-router under an already-versioned parent
// (/api/v1/nvr). The whole tree is behind localauth.Authenticate (dual-mode auth),
// then delegates to per-domain mount funcs. Domain handlers (cameras/nvrs/…) are
// filled in later stages; the skeleton keeps them as compiling no-ops.
func Mount(r chi.Router, d *Deps) {
	auth := localauth.NewAuthenticator(d.Auth, nil, d.DB)
	r.Route("/estate", func(rr chi.Router) {
		// Local login/logout precede a session (login) or only need the raw bearer
		// to revoke (logout), so they sit OUTSIDE the dual-mode Authenticate gate.
		mountAuthPublic(rr, d)

		// Everything else requires an authenticated caller (local session / central
		// JWT / node credential).
		rr.Group(func(g chi.Router) {
			g.Use(auth.Authenticate)
			mountNode(g, d)
			mountAuth(g, d) // /local-users management (admin local role only)
			mountCameras(g, d)
			mountNvrs(g, d)
			mountRecording(g, d)
			mountStorage(g, d)
			mountPtz(g, d)
			mountLive(g, d) // node-issued live/playback/recordings (media tokens)
		})
	})
}
