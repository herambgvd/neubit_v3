package estate

import "github.com/go-chi/chi/v5"

// mountRecording wires the recording-config estate endpoints (spec §6.1
// "Recording config"). Filled in a later stage; the skeleton keeps it a compiling
// no-op.
func mountRecording(r chi.Router, d *Deps) {
	// TODO(stage-c): GET|PUT /cameras/{id}/recording + recording/start|stop over d.DB.
}
