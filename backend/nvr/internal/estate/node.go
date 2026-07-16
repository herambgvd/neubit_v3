package estate

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	kerr "github.com/neubit/gokernel/errors"
	"github.com/neubit/gokernel/httpx"

	"github.com/neubit/nvr/internal/hwstat"
	"github.com/neubit/nvr/internal/store"
)

// mountNode wires the node self + health endpoints (spec §6.1 "Node self"):
//
//	GET /estate/node   → node identity (id/name/enroll_state/last_sync)
//	GET /estate/health → local diagnostics summary (DB/store/recording/streaming +
//	                     disk usage of the recordings volume + RAID health)
func mountNode(r chi.Router, d *Deps) {
	h := &nodeHandler{d: d}
	r.Get("/node", h.self)
	r.Get("/health", h.health)
}

type nodeHandler struct{ d *Deps }

// self returns the node's identity + enrollment/sync state (spec §6.1). Before the
// first-boot bootstrap the identity row is absent — surface that as 404 rather than
// a 500 so a caller can tell "not yet bootstrapped" apart from a store error.
func (h *nodeHandler) self(w http.ResponseWriter, r *http.Request) {
	ident, err := h.d.DB.GetNodeIdentity(r.Context())
	if err != nil {
		kerr.Write(w, kerr.NotFound("node identity not found (not bootstrapped)"))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":               ident.ID,
		"name":             ident.Name,
		"tenant_id":        ident.TenantID,
		"enroll_state":     ident.EnrollState,
		"enrolled_at":      ident.EnrolledAt,
		"last_sync_at":     ident.LastSyncAt,
		"central_base_url": ident.CentralBaseURL,
	})
}

// health returns a local diagnostics summary. It never fails on hardware probes:
// a disk or RAID read error degrades gracefully (the field is omitted / carries an
// error string) so a box with no mdadm or an unusual mount still returns 200.
func (h *nodeHandler) health(w http.ResponseWriter, r *http.Request) {
	summary := map[string]any{
		"db_ok":     h.dbOK(r),
		"store":     "sqlite",
		"recording": true,
		"streaming": true,
	}

	// Storage: disk usage of the recordings volume (env VE_RECORDINGS_DIR).
	recDir := os.Getenv("VE_RECORDINGS_DIR")
	if recDir == "" {
		recDir = "/recordings"
	}
	if usage, err := hwstat.Disk(recDir); err != nil {
		summary["storage"] = map[string]any{"path": recDir, "error": err.Error()}
	} else {
		summary["storage"] = usage
	}

	// RAID: md-array health (empty [] on a box without software RAID, not null).
	if arrays, err := hwstat.RaidArrays(); err != nil {
		summary["raid"] = map[string]any{"error": err.Error()}
	} else if arrays == nil {
		summary["raid"] = []store.RaidArray{}
	} else {
		summary["raid"] = arrays
	}

	httpx.JSON(w, http.StatusOK, summary)
}

// dbOK is a cheap liveness probe against the estate store (a 1-row read).
func (h *nodeHandler) dbOK(r *http.Request) bool {
	if _, err := h.d.DB.ListAudit(r.Context(), 1); err != nil {
		return false
	}
	return true
}
