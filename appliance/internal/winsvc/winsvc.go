// Package winsvc registers and runs neubitvms-svc as the Windows Service
// "NeubitVMS" — what makes the VMS run after a reboot with nobody signed in.
//
// Registration follows the NVR's (neubit_nvr internal/appliance/winsvc):
//
//   - a virtual account, NT SERVICE\NeubitVMS, not LocalSystem: the stack can
//     touch only what the installer granted it (the data root);
//   - an unrestricted per-service SID, so that account is ACL-able, and the
//     write-restricted token does not break postgres/node;
//   - auto start (not delayed), recovery actions restarting it after 5 s, 15 s,
//     60 s, also on a non-crash failure exit;
//   - a pre-shutdown timeout, because Windows otherwise gives a service a few
//     seconds at reboot — not enough for Postgres to stop cleanly;
//   - a quoted binary path (the unquoted-service-path escalation).
package winsvc

import "time"

const (
	Name        = "NeubitVMS"
	DisplayName = "Neubit VMS Server"
	Description = "Neubit VMS server: database, event bus, services and the web console. " +
		"Runs with nobody signed in. Manage it from the Neubit VMS app's service panel."

	// ShutdownBudget is the pre-shutdown time asked for: the supervisor's stop
	// graces (30 s polite + 15 s kill) per dependency level, with margin.
	ShutdownBudget = 3 * time.Minute
)

// VirtualAccount is the service's own account name.
func VirtualAccount(name string) string { return `NT SERVICE\` + name }
