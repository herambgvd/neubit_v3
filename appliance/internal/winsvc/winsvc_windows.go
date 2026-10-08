//go:build windows

package winsvc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// IsService reports whether the SCM started this process.
func IsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// Run runs fn under the SCM, or in the console (Ctrl+C stops) when started by
// hand — the same binary is debuggable from a terminal.
func Run(name string, fn func(ctx context.Context) error) error {
	if !IsService() {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		fmt.Fprintf(os.Stderr, "%s: running in the console (not as a service); Ctrl+C stops it\n", name)
		return fn(ctx)
	}
	h := &handler{run: fn}
	if err := svc.Run(name, h); err != nil {
		return fmt.Errorf("service %q could not reach the service control manager: %w", name, err)
	}
	return h.err
}

type handler struct {
	run func(context.Context) error
	err error
}

const accepts = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptPreShutdown

func (h *handler) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending, WaitHint: 30000}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		var err error
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("supervisor panicked: %v", p)
			}
			done <- err
		}()
		err = h.run(ctx)
	}()

	// The supervisor starts its processes asynchronously; the service is
	// "running" as soon as it is supervising. Readiness is /v1/status's job.
	changes <- svc.Status{State: svc.Running, Accepts: accepts}
	checkpoint := uint32(0)
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
loop:
	for {
		select {
		case err := <-done:
			return h.finish(err)
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown, svc.PreShutdown:
				break loop
			}
		}
	}
	// Graceful unwind with no deadline of our own: the SCM's pre-shutdown budget
	// is the backstop. Keep the checkpoint climbing so it waits for Postgres.
	cancel()
	for {
		checkpoint++
		changes <- svc.Status{State: svc.StopPending, CheckPoint: checkpoint, WaitHint: 20000}
		select {
		case err := <-done:
			return h.finish(err)
		case c := <-r:
			if c.Cmd == svc.Interrogate {
				changes <- c.CurrentStatus
			}
		case <-tick.C:
		}
	}
}

func (h *handler) finish(err error) (bool, uint32) {
	if errors.Is(err, context.Canceled) {
		err = nil
	}
	h.err = err
	if err == nil {
		return false, 0
	}
	// A service-specific non-zero exit + the non-crash-failure flag makes the
	// SCM apply its recovery actions (restart).
	return true, 1
}

// quoted builds the binary path: the exe always quoted.
func quoted(exe string, args []string) string {
	parts := []string{`"` + exe + `"`}
	for _, a := range args {
		if strings.ContainsAny(a, " \t\"") {
			a = `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

func config(exe string, args []string) mgr.Config {
	return mgr.Config{
		ServiceType:      windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:        mgr.StartAutomatic,
		ErrorControl:     mgr.ErrorNormal,
		DisplayName:      DisplayName,
		Description:      Description,
		BinaryPathName:   quoted(exe, args),
		ServiceStartName: VirtualAccount(Name),
		SidType:          windows.SERVICE_SID_TYPE_UNRESTRICTED,
	}
}

type preshutdownInfo struct{ Timeout uint32 }

// Install registers the service, or updates it in place on an upgrade (never
// delete + create, which would lose the recovery settings for a moment).
func Install(exe string, args []string) error {
	if _, err := os.Stat(exe); err != nil {
		return fmt.Errorf("service executable %s: %w", exe, err)
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("opening the service manager (run elevated): %w", err)
	}
	defer m.Disconnect()
	cfg := config(exe, args)
	s, err := m.OpenService(Name)
	if err == nil {
		defer s.Close()
		if err := s.UpdateConfig(cfg); err != nil {
			return fmt.Errorf("updating service %s: %w", Name, err)
		}
	} else {
		s, err = m.CreateService(Name, exe, cfg, args...)
		if err != nil {
			return fmt.Errorf("creating service %s: %w", Name, err)
		}
		defer s.Close()
	}
	info := preshutdownInfo{Timeout: uint32(ShutdownBudget / time.Millisecond)}
	if err := windows.ChangeServiceConfig2(s.Handle, windows.SERVICE_CONFIG_PRESHUTDOWN_INFO, (*byte)(unsafe.Pointer(&info))); err != nil {
		return fmt.Errorf("setting the pre-shutdown timeout (without it Windows hard-kills the database at reboot): %w", err)
	}
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 15 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}, uint32((24 * time.Hour).Seconds())); err != nil {
		return fmt.Errorf("setting recovery actions: %w", err)
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("setting recovery on non-crash failures: %w", err)
	}
	return nil
}

// Uninstall stops and removes the service. Data is untouched. Not installed is success.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return nil
	}
	defer s.Close()
	_ = stopAndWait(s, 5*time.Minute)
	return s.Delete()
}

// Control starts, stops or restarts the service and waits for the result.
func Control(action string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("opening the service manager (run elevated): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return fmt.Errorf("service %s is not installed", Name)
	}
	defer s.Close()
	switch action {
	case "start":
		return startAndWait(s, 2*time.Minute)
	case "stop":
		return stopAndWait(s, 5*time.Minute)
	case "restart":
		if err := stopAndWait(s, 5*time.Minute); err != nil {
			return err
		}
		return startAndWait(s, 2*time.Minute)
	}
	return fmt.Errorf("unknown action %q", action)
}

// Query reports the SCM state, or "not installed".
func Query() string {
	m, err := mgr.Connect()
	if err != nil {
		return "unknown"
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return "not installed"
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return "unknown"
	}
	return stateName(st.State)
}

func stateName(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "starting"
	case svc.StopPending:
		return "stopping"
	case svc.Running:
		return "running"
	}
	return "unknown"
}

func startAndWait(s *mgr.Service, d time.Duration) error {
	st, err := s.Query()
	if err == nil && st.State == svc.Running {
		return nil
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("starting %s: %w", Name, err)
	}
	return wait(s, svc.Running, d)
}

func stopAndWait(s *mgr.Service, d time.Duration) error {
	st, err := s.Query()
	if err == nil && st.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("stopping %s: %w", Name, err)
	}
	return wait(s, svc.Stopped, d)
}

func wait(s *mgr.Service, want svc.State, d time.Duration) error {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("%s did not reach %s within %s", Name, stateName(want), d)
}
