package estate

import "github.com/go-chi/chi/v5"

// mountNvrs wires the registered-NVR estate endpoints (spec §6.1 "NVRs"). Filled
// in a later stage; the skeleton keeps it a compiling no-op.
func mountNvrs(r chi.Router, d *Deps) {
	// TODO(stage-c): NVR CRUD over d.DB, each recording an audit_log row.
}
