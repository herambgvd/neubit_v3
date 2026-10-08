//go:build windows

// Package acl seals the data root: SYSTEM, Administrators and the service's own
// virtual account, nobody else. The database, the secrets and the footage of a
// security system are not readable by every user who can sign in to the server.
package acl

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Well-known SIDs, not names: "Administrators" is localised on a German or
// Japanese Windows and icacls would fail there.
const (
	sidSystem = "*S-1-5-18"
	sidAdmins = "*S-1-5-32-544"
)

// SealDataRoot replaces the root's DACL (inheritance removed); everything below
// inherits it. The service account must already exist (after the service is
// registered).
//
// NOT /T. With /T icacls also strips inheritance from every file below, and the
// (OI)(CI) grants do not apply to a file, so each file is left with an EMPTY
// DACL: nobody, SYSTEM included, can read it. Changing the root alone is enough;
// children holding inherited ACEs pick the new ones up.
func SealDataRoot(root, serviceAccount string) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	icacls := filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe")
	args := []string{root, "/inheritance:r"}
	// Full control, inherited by every file (OI) and folder (CI) below.
	for _, who := range []string{sidSystem, sidAdmins, serviceAccount} {
		args = append(args, "/grant:r", who+":(OI)(CI)F")
	}
	args = append(args, "/C", "/Q")
	out, err := exec.Command(icacls, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %s: %w: %s", root, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ReadOnlyForUsers lets signed-in users read one file (control.json, so the
// desktop app can find the control API without elevation).
func ReadOnlyForUsers(path string) error {
	icacls := filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe")
	out, err := exec.Command(icacls, path, "/grant", "*S-1-5-32-545:R").CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}
