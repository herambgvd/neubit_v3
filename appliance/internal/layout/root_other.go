//go:build !windows

package layout

import (
	"os"
	"strings"
)

// ResolveRoot off Windows: flag, then NEUBIT_VMS_ROOT, then /var/lib/neubit/vms.
// (Linux packaging is a later phase; this keeps the code building and testable.)
func ResolveRoot(flag string) string {
	if v := strings.TrimSpace(flag); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv(EnvRoot)); v != "" {
		return v
	}
	return DefaultRoot()
}

func DefaultRoot() string { return "/var/lib/neubit/vms" }

func WriteRegistryRoot(string) error { return nil }

func RootForInstallDir(string) string { return DefaultRoot() }
