//go:build !windows

package supervise

import (
	"os"
	"syscall"
)

func childProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

func politeStop(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

// contain and release are the Windows job object's hooks. Here the process
// group from Setpgid already holds the tree, and hardKill signals the group.
func (c *execChild) contain() {
	// Nothing to do: Setpgid made the group at spawn.
}

func (c *execChild) release() {
	// Nothing to release: a process group needs no handle.
}

func hardKill(c *execChild) error {
	// The whole process group, so a child's own children go too.
	if err := syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return c.cmd.Process.Kill()
}
