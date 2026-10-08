//go:build windows

package supervise

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows has no SIGTERM. A console control event reaches only processes that
// share the sender's console, so: the supervisor makes sure it HAS a console
// (a service starts without one), each child gets CREATE_NEW_PROCESS_GROUP so
// CTRL_BREAK can be aimed at it alone, and each child runs in a
// KILL_ON_JOB_CLOSE job so a kill — or the supervisor dying — takes everything
// it started (postgres backends, node workers). Python delivers CTRL_BREAK as
// SIGBREAK; uvicorn and core's shutdown hook both stop on it; postgres treats it
// as a fast shutdown. Same approach as the NVR's supervisor.
var (
	consoleMu sync.Mutex
	consoleOK bool

	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	procAllocConsole = kernel32.NewProc("AllocConsole")
	procGetConsoleW  = kernel32.NewProc("GetConsoleWindow")
	procGetConsoleCP = kernel32.NewProc("GetConsoleCP")
)

func hasConsole() bool {
	if h, _, _ := procGetConsoleW.Call(); h != 0 {
		return true
	}
	cp, _, _ := procGetConsoleCP.Call()
	return cp != 0 // ConPTY has no console window but does have a code page
}

func ensureConsole() error {
	consoleMu.Lock()
	defer consoleMu.Unlock()
	if consoleOK || hasConsole() {
		consoleOK = true
		return nil
	}
	r, _, err := procAllocConsole.Call()
	if r != 0 {
		if !hasConsole() {
			return errors.New("AllocConsole succeeded but there is still no console")
		}
		consoleOK = true
		return nil
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		consoleOK = true // already attached
		return nil
	}
	return fmt.Errorf("AllocConsole: %w", err)
}

func childProcAttr() *syscall.SysProcAttr {
	_ = ensureConsole() // without it the stop is a kill, not a failure to start
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

func politeStop(p *os.Process) error {
	if err := ensureConsole(); err != nil {
		return err
	}
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(p.Pid))
}

func (c *execChild) contain() {
	if c.cmd.Process == nil {
		return
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(c.cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	c.mu.Lock()
	c.job = uintptr(job)
	c.mu.Unlock()
}

func (c *execChild) release() {
	c.mu.Lock()
	job := c.job
	c.job = 0
	c.mu.Unlock()
	if job != 0 {
		_ = windows.CloseHandle(windows.Handle(job))
	}
}

func hardKill(c *execChild) error {
	c.mu.Lock()
	job := c.job
	c.mu.Unlock()
	if job != 0 {
		if err := windows.TerminateJobObject(windows.Handle(job), 1); err == nil {
			return nil
		}
	}
	return c.cmd.Process.Kill()
}
