//go:build windows

package layout

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// RegistryKey holds DataRoot, written by the installer in the 64-bit view.
const RegistryKey = `SOFTWARE\Neubit\VMS`

// ResolveRoot picks the data root: an explicit flag, then NEUBIT_VMS_ROOT, then
// the installer's registry value, then %ProgramData%\Neubit\VMS.
//
// The registry is read in the 64-bit view explicitly: the NSIS installer runs
// 32-bit PowerShell, which would otherwise write and read WOW6432Node.
func ResolveRoot(flag string) string {
	if v := strings.TrimSpace(flag); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv(EnvRoot)); v != "" {
		return v
	}
	if v := registryRoot(); v != "" {
		return v
	}
	return DefaultRoot()
}

func registryRoot() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, RegistryKey, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("DataRoot")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(v)
}

// WriteRegistryRoot records the data root for the shell and for later runs.
func WriteRegistryRoot(root string) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, RegistryKey, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("DataRoot", root)
}

// DefaultRoot is %ProgramData%\Neubit\VMS.
func DefaultRoot() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Neubit", "VMS")
}

// RootForInstallDir applies the follow-the-big-disk rule: a program installed
// on a drive other than the Windows drive keeps its data on that drive.
func RootForInstallDir(installDir string) string {
	vol := filepath.VolumeName(installDir)
	sys := filepath.VolumeName(os.Getenv("SystemRoot"))
	if vol == "" || sys == "" || strings.EqualFold(vol, sys) {
		return DefaultRoot()
	}
	return vol + `\NeubitVMS`
}
