//go:build !windows

package acl

import "os"

func SealDataRoot(root, _ string) error { return os.Chmod(root, 0o700) }

func ReadOnlyForUsers(string) error { return nil }
