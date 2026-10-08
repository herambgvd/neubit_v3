package supervise

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// startingPrefix marks a health probe that failed inside the start period.
const startingPrefix = "starting: "

type command int

const (
	cmdRestart command = iota + 1
	cmdStop
	cmdStart
)

// runner owns one Proc: one goroutine, one child at a time. Shutdown and the
// operator controls reach it only through channels, so neither can deadlock it.
type runner struct {
	sup  *Supervisor
	spec Proc
	deps []*runner

	ready     chan struct{} // closed when first healthy (or completed)
	readyOnce sync.Once
	gaveUp    chan struct{}
	gaveOnce  sync.Once
	stopCh    chan struct{} // closed by shutdown
	stopOnce  sync.Once
	done      chan struct{} // closed when run returns
	cmds      chan command

	mu   sync.Mutex
	st   Status
	held bool

	logw io.WriteCloser
}

func newRunner(s *Supervisor, p Proc) *runner {
	return &runner{
		sup:    s,
		spec:   p,
		ready:  make(chan struct{}),
		gaveUp: make(chan struct{}),
		stopCh: make(chan struct{}),
		done:   make(chan struct{}),
		cmds:   make(chan command, 4),
		st: Status{
			Name: p.Name, State: StatePending, Since: s.now(),
			Critical: p.Critical, OneShot: p.OneShot,
		},
	}
}

type outcomeKind int

const (
	outExited     outcomeKind = iota // the child exited (or never started)
	outHealthFail                    // stopped for failing its health check
	outCompleted                     // a one-shot exited 0
	outShutdown                      // the supervisor is stopping
	outCommand                       // an operator command interrupted it
)

type outcome struct {
	kind       outcomeKind
	reason     string
	exitCode   *int
	cmd        command
	healthyFor time.Duration
}

func (r *runner) run() {
	defer close(r.done)
	defer r.closeLog()
	if !r.waitDeps() {
		return
	}
	attempt := 0
	for {
		held, ok := r.awaitTurn()
		if !ok {
			return
		}
		if held {
			attempt = 0
		}

		out := r.runOnce()
		switch out.kind {
		case outShutdown:
			r.set(StateStopped, 0, "", out.exitCode)
			return
		case outCompleted:
			if !r.idleAfterCompletion(out) {
				return
			}
			attempt = 0
		case outCommand:
			r.applyCommand(out.cmd)
			attempt = 0
		default:
			// A failure: exited, or failed its health check.
			var again bool
			if attempt, again = r.afterFailure(out, attempt); !again {
				return
			}
		}
	}
}

// awaitTurn waits out an operator's stop and then the gate. held reports an
// operator stop (a fresh start resets the backoff); ok is false once the
// service is stopping.
func (r *runner) awaitTurn() (held, ok bool) {
	if r.isHeld() {
		held = true
		r.set(StateStopped, 0, "stopped by an operator", nil)
		if !r.waitRelease() {
			return held, false
		}
	}
	return held, r.waitGate()
}

// idleAfterCompletion parks a one-shot that finished: done until someone asks
// to run it again, or the service stops (false).
func (r *runner) idleAfterCompletion(out outcome) bool {
	r.set(StateCompleted, 0, "", out.exitCode)
	r.markReady()
	select {
	case <-r.stopCh:
		return false
	case c := <-r.cmds:
		r.applyCommand(c)
		return true
	}
}

// afterFailure counts a failure, then gives up past MaxRestarts or waits out
// the backoff. It returns the next attempt number, and false once the runner
// should end.
func (r *runner) afterFailure(out outcome, attempt int) (int, bool) {
	if out.healthyFor >= r.sup.tun.RestartReset {
		attempt = 0
	}
	attempt++
	r.bumpRestarts()
	if r.sup.tun.MaxRestarts > 0 && attempt > r.sup.tun.MaxRestarts {
		why := fmt.Sprintf("gave up after %d restarts: %s", r.sup.tun.MaxRestarts, out.reason)
		r.set(StateFailed, 0, why, out.exitCode)
		r.gaveOnce.Do(func() { close(r.gaveUp) })
		r.sup.giveUp(r.spec.Name, r.spec.Critical, why)
		<-r.stopCh
		return attempt, false
	}
	delay := backoff(r.sup.tun, attempt)
	r.set(StateRestarting, 0, out.reason, out.exitCode)
	r.sup.log.Warn("process will restart", "proc", r.spec.Name, "in", delay.String(), "reason", out.reason)
	select {
	case <-r.stopCh:
		r.set(StateStopped, 0, out.reason, out.exitCode)
		return attempt, false
	case c := <-r.cmds:
		r.applyCommand(c)
		return 0, true
	case <-time.After(delay):
		return attempt, true
	}
}

// healthClock remembers when a child first answered its health check, so a
// crash after a long healthy run resets the backoff.
type healthClock struct {
	mu    sync.Mutex
	since time.Time
}

func (h *healthClock) mark(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.since.IsZero() {
		h.since = now
	}
}

func (h *healthClock) age(now time.Time) time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.since.IsZero() {
		return 0
	}
	return now.Sub(h.since)
}

// promoteHealthy moves a starting child to healthy and releases dependents.
func (r *runner) promoteHealthy() {
	r.mu.Lock()
	if r.st.State == StateStarting {
		r.st.State, r.st.Since = StateHealthy, r.sup.now()
	}
	// A probe refused while the process was still starting is not news once
	// it answers; the reason for a previous crash or restart is, so keep it.
	if strings.HasPrefix(r.st.LastError, startingPrefix) {
		r.st.LastError = ""
	}
	r.mu.Unlock()
	r.markReady()
}

func backoff(t Tuning, attempt int) time.Duration {
	d := t.RestartBase
	for i := 1; i < attempt && d < t.RestartMax; i++ {
		d *= 2
	}
	if d > t.RestartMax {
		d = t.RestartMax
	}
	return d
}

func (r *runner) applyCommand(c command) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch c {
	case cmdStop:
		r.held = true
	case cmdStart, cmdRestart:
		r.held = false
	}
	r.st.Held = r.held
}

func (r *runner) isHeld() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.held
}

// waitRelease blocks while held. False means the supervisor is stopping.
func (r *runner) waitRelease() bool {
	for {
		select {
		case <-r.stopCh:
			return false
		case c := <-r.cmds:
			r.applyCommand(c)
			if !r.isHeld() {
				return true
			}
		}
	}
}

func (r *runner) waitDeps() bool {
	for _, d := range r.deps {
		select {
		case <-d.ready:
		case <-r.stopCh:
			r.set(StateStopped, 0, "", nil)
			return false
		case <-d.gaveUp:
			r.set(StateFailed, 0, fmt.Sprintf("dependency %s gave up", d.spec.Name), nil)
			r.gaveOnce.Do(func() { close(r.gaveUp) })
			<-r.stopCh
			return false
		}
	}
	return true
}

func (r *runner) waitGate() bool {
	if r.spec.Gate == nil {
		return true
	}
	for {
		err := r.spec.Gate()
		if err == nil {
			return true
		}
		r.set(StateWaiting, 0, err.Error(), nil)
		select {
		case <-r.stopCh:
			r.set(StateStopped, 0, "", nil)
			return false
		case c := <-r.cmds:
			r.applyCommand(c)
			if r.isHeld() {
				r.set(StateStopped, 0, "stopped by an operator", nil)
				if !r.waitRelease() {
					return false
				}
			}
		case <-time.After(r.sup.tun.GateInterval):
		}
	}
}

func (r *runner) runOnce() outcome {
	w := r.logWriter()
	child, err := r.sup.spawner.Start(r.spec, w, w)
	if err != nil {
		r.sup.log.Error("process failed to start", "proc", r.spec.Name, "err", err)
		return outcome{kind: outExited, reason: "could not start: " + err.Error()}
	}
	started := r.sup.now()
	r.mu.Lock()
	r.st.State, r.st.PID, r.st.Since, r.st.Started, r.st.LastError, r.st.ExitCode =
		StateStarting, child.PID(), started, started, "", nil
	r.mu.Unlock()
	r.sup.log.Info("process started", "proc", r.spec.Name, "pid", child.PID())

	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()

	hctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	healthFail := make(chan string, 1)
	var clock healthClock
	onHealthy := func() {
		clock.mark(r.sup.now())
		r.promoteHealthy()
	}
	healthyFor := func() time.Duration { return clock.age(r.sup.now()) }

	if !r.spec.OneShot {
		if r.spec.Health == nil {
			onHealthy()
		} else {
			go r.healthLoop(hctx, started, onHealthy, healthFail)
		}
	}

	for {
		select {
		case err := <-exited:
			code := exitCode(err)
			if r.spec.OneShot && err == nil {
				r.sup.log.Info("one-shot completed", "proc", r.spec.Name)
				return outcome{kind: outCompleted, exitCode: code}
			}
			desc := exitDesc(err)
			r.sup.log.Warn("process exited", "proc", r.spec.Name, "how", desc)
			return outcome{kind: outExited, reason: desc, exitCode: code, healthyFor: healthyFor()}
		case why := <-healthFail:
			hf := healthyFor()
			r.sup.log.Warn("process unhealthy, restarting it", "proc", r.spec.Name, "why", why)
			r.terminate(child, exited)
			return outcome{kind: outHealthFail, reason: why, healthyFor: hf}
		case <-r.stopCh:
			r.terminate(child, exited)
			return outcome{kind: outShutdown}
		case c := <-r.cmds:
			if c == cmdStart {
				continue // already running: nothing to start
			}
			r.sup.log.Info("operator command", "proc", r.spec.Name, "cmd", c)
			r.terminate(child, exited)
			return outcome{kind: outCommand, cmd: c}
		}
	}
}

// healthLoop probes every interval. Failures inside the start period do not
// count until the process has been healthy once; after that, HealthRetries
// consecutive failures report it unhealthy.
func (r *runner) healthLoop(ctx context.Context, started time.Time, onHealthy func(), fail chan<- string) {
	t := r.sup.tun
	consecutive := 0
	everHealthy := false
	var last error
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(t.HealthInterval):
		}
		pctx, cancel := context.WithTimeout(ctx, t.HealthTimeout)
		err := r.spec.Health(pctx)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			consecutive = 0
			everHealthy = true
			onHealthy()
			continue
		}
		last = err
		if !everHealthy && r.sup.now().Sub(started) < t.StartPeriod {
			r.mu.Lock()
			r.st.LastError = startingPrefix + err.Error()
			r.mu.Unlock()
			continue
		}
		consecutive++
		if consecutive >= t.HealthRetries {
			select {
			case fail <- fmt.Sprintf("health check failed %d times: %v", consecutive, last):
			default:
			}
			return
		}
	}
}

// terminate asks politely (CTRL_BREAK / SIGTERM), then kills after StopGrace.
func (r *runner) terminate(c Child, exited <-chan error) {
	if err := c.Signal(); err != nil {
		r.sup.log.Warn("polite stop not delivered, killing", "proc", r.spec.Name, "err", err)
		_ = c.Kill()
	} else {
		select {
		case <-exited:
			return
		case <-time.After(r.sup.tun.StopGrace):
			r.sup.log.Warn("process ignored the stop request, killing", "proc", r.spec.Name)
			_ = c.Kill()
		}
	}
	select {
	case <-exited:
	case <-time.After(r.sup.tun.KillGrace):
		r.sup.log.Error("process survived kill; abandoning it", "proc", r.spec.Name)
	}
}

func (r *runner) shutdown() {
	r.stopOnce.Do(func() { close(r.stopCh) })
	<-r.done
}

func (r *runner) send(c command) error {
	select {
	case r.cmds <- c:
		return nil
	default:
		return errors.New("busy: a previous command is still being applied")
	}
}

func (r *runner) markReady() { r.readyOnce.Do(func() { close(r.ready) }) }

func (r *runner) set(s State, pid int, lastErr string, code *int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.State, r.st.PID, r.st.Since, r.st.LastError, r.st.ExitCode = s, pid, r.sup.now(), lastErr, code
	r.st.Held = r.held
}

func (r *runner) bumpRestarts() {
	r.mu.Lock()
	r.st.Restarts++
	r.mu.Unlock()
}

func (r *runner) status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.st
}

func (r *runner) logWriter() io.Writer {
	if r.spec.LogFile == "" {
		return io.Discard
	}
	if r.logw == nil {
		f, err := OpenLog(r.spec.LogFile)
		if err != nil {
			r.sup.log.Error("cannot open process log", "proc", r.spec.Name, "err", err)
			return io.Discard
		}
		r.logw = f
	}
	return r.logw
}

func (r *runner) closeLog() {
	if r.logw != nil {
		_ = r.logw.Close()
		r.logw = nil
	}
}

func exitCode(err error) *int {
	if err == nil {
		z := 0
		return &z
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		c := ee.ExitCode()
		return &c
	}
	return nil
}

// exitDesc never includes child output: stderr can hold a DSN.
func exitDesc(err error) string {
	if err == nil {
		return "exited cleanly (status 0)"
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return fmt.Sprintf("exited with status %d", ee.ExitCode())
	}
	return "exited: " + err.Error()
}
