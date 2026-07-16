package estate

import "github.com/go-chi/chi/v5"

// mountPtz wires the PTZ estate endpoints (spec §6.1 "PTZ"). Filled in a later
// stage; the skeleton keeps it a compiling no-op.
func mountPtz(r chi.Router, d *Deps) {
	// TODO(stage-c): preset/patrol CRUD + goto/move/start/stop over d.DB.
}
