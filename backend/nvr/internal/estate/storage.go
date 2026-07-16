package estate

import "github.com/go-chi/chi/v5"

// mountStorage wires the storage + RAID estate endpoints (spec §6.1
// "Storage / RAID"). Filled in a later stage; the skeleton keeps it a compiling
// no-op.
func mountStorage(r chi.Router, d *Deps) {
	// TODO(stage-c): pool CRUD + test, tier-rule CRUD, GET /storage/raid over d.DB.
}
