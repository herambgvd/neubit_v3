package estate

import "github.com/go-chi/chi/v5"

// mountCameras wires the camera estate endpoints (spec §6.1 "Cameras"). Filled in
// a later stage; the skeleton keeps it a compiling no-op.
func mountCameras(r chi.Router, d *Deps) {
	// TODO(stage-c): list/create/get/patch/delete/bulk/reorder + advanced-config +
	// snapshot + apply-stream-policy over d.DB, each recording an audit_log row.
}
