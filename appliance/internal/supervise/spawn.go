package supervise

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// Child is one running process as the runner sees it.
type Child interface {
	PID() int
	Wait() error   // once; returns after output is fully copied
	Signal() error // polite stop; must not block on the exit
	Kill() error   // the process and everything it started
}

// Spawner starts Children; tests substitute a fake.
type Spawner interface {
	Start(p Proc, stdout, stderr io.Writer) (Child, error)
}

// ExecSpawner starts real processes.
type ExecSpawner struct{}

func (ExecSpawner) Start(p Proc, stdout, stderr io.Writer) (Child, error) {
	if strings.TrimSpace(p.Exe) == "" {
		return nil, errors.New("no executable configured")
	}
	cmd := exec.Command(p.Exe, p.Args...)
	cmd.Dir = p.Dir
	cmd.Env = MergeEnv(hostBaseEnv(), p.Env)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = nil // a child reading a missing terminal would hang forever
	cmd.SysProcAttr = childProcAttr()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &execChild{cmd: cmd}
	c.contain()
	return c, nil
}

type execChild struct {
	cmd *exec.Cmd
	mu  sync.Mutex
	job uintptr // Windows job object
}

func (c *execChild) PID() int {
	if c.cmd.Process == nil {
		return 0
	}
	return c.cmd.Process.Pid
}

func (c *execChild) Wait() error {
	err := c.cmd.Wait()
	c.release()
	return err
}

func (c *execChild) Signal() error {
	if c.cmd.Process == nil {
		return errors.New("not started")
	}
	return politeStop(c.cmd.Process)
}

func (c *execChild) Kill() error {
	if c.cmd.Process == nil {
		return errors.New("not started")
	}
	return hardKill(c)
}

// hostEnvAllowList is all of the machine environment a child inherits: never
// os.Environ(), so a stray VE_* or NODE_OPTIONS on the server cannot override
// what the supervisor configured. Windows cannot run without these (no
// SystemRoot → Winsock fails).
var hostEnvAllowList = []string{
	"SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
	"TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
	"ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
	"CommonProgramFiles", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "TZ",
	// PATH is set per process by the stack (runtimes first), not inherited.
	"HOME", "LANG",
}

func hostBaseEnv() []string {
	out := make([]string, 0, len(hostEnvAllowList))
	for _, n := range hostEnvAllowList {
		if v, ok := os.LookupEnv(n); ok {
			out = append(out, n+"="+v)
		}
	}
	return out
}

// MergeEnv layers extra over base by key; keys fold case on Windows.
func MergeEnv(base, extra []string) []string {
	fold := runtime.GOOS == "windows"
	key := func(kv string) string {
		k, _, _ := strings.Cut(kv, "=")
		if fold {
			return strings.ToUpper(k)
		}
		return k
	}
	idx := map[string]int{}
	out := make([]string, 0, len(base)+len(extra))
	add := func(kv string) {
		k := key(kv)
		if k == "" {
			return
		}
		if i, ok := idx[k]; ok {
			out[i] = kv
			return
		}
		idx[k] = len(out)
		out = append(out, kv)
	}
	for _, kv := range base {
		add(kv)
	}
	for _, kv := range extra {
		add(kv)
	}
	return out
}
