//go:build windows

package acl

import (
	"os"
	"os/user"
	"path/filepath"
	"testing"
)

// Sealed to SYSTEM, Administrators and (here) the test's own account, a file
// below the root must stay readable by that account. With /T every file was
// left with an empty DACL, the service could not read its own data, and the
// install failed with "Access is denied".
func TestFilesBelowTheRootKeepAnInheritedDACL(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "config")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(sub, "secrets.env")
	if err := os.WriteFile(file, []byte("K=V\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	me, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	if err := SealDataRoot(root, me.Username); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("a file below the sealed root is unreadable: %v", err)
	}
	if string(b) != "K=V\n" {
		t.Fatalf("read %q", b)
	}
}
