// Package supervise is the native appliance's process manager — what
// docker-compose does for the Docker stack: start in dependency order once each
// dependency is healthy, health-check, restart with backoff (a clean exit is
// still restarted, as `restart: unless-stopped`), run one-shot jobs to
// completion (the migrations), stop in reverse order, and keep each process's
// output in a rotating log.
//
// Modelled on the NVR's supervisor (neubit_nvr internal/appliance/supervise),
// re-written here rather than shared: the two products ship and version apart.
// Spawner and clock are injectable so the policy is testable without processes.
package supervise

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Proc describes one supervised process. Pure data.
type Proc struct {
	Name string
	Exe  string // absolute path; never a PATH lookup
	Args []string
	Env  []string // layered over a small host allow-list, not os.Environ()
	Dir  string

	// DependsOn must each be healthy (or, for a one-shot, completed) once before
	// this process starts, and outlive it at shutdown.
	DependsOn []string

	// Health probes readiness; nil means "running is healthy". Never put a
	// password or DSN in its error: it is shown on the control API.
	Health func(context.Context) error

	// Gate, when set, must return nil before the process is started. Used for
	// optional processes whose data may not exist yet (the geocoder before its
	// index is downloaded). Re-checked every GateInterval; shown as "waiting".
	Gate func() error

	// OneShot processes run to completion (exit 0) and are not restarted after
	// that: schema migrations. A non-zero exit is retried with backoff, and
	// dependents wait — a service never starts on an unmigrated schema.
	OneShot bool

	// Critical: if it can never become healthy (MaxRestarts exhausted) the whole
	// service stops and the SCM's recovery actions take over. With the default
	// unlimited restarts this is informational (Status shows it).
	Critical bool

	// LogFile receives the process's stdout+stderr, one timestamped line each.
	LogFile string
}

// State is where a process is in its lifecycle.
type State string

const (
	StatePending    State = "pending"    // waiting for dependencies
	StateWaiting    State = "waiting"    // its Gate said not yet
	StateStarting   State = "starting"   // spawned, not yet healthy
	StateHealthy    State = "healthy"    // running and passing health
	StateCompleted  State = "completed"  // one-shot finished with exit 0
	StateRestarting State = "restarting" // in backoff before the next start
	StateStopped    State = "stopped"    // stopped (shutdown or operator)
	StateFailed     State = "failed"     // gave up
)

// Status is a snapshot, safe to serialise onto the control API.
type Status struct {
	Name      string    `json:"name"`
	State     State     `json:"state"`
	PID       int       `json:"pid"`
	Restarts  int       `json:"restarts"`
	LastError string    `json:"last_error,omitempty"`
	ExitCode  *int      `json:"exit_code,omitempty"`
	Since     time.Time `json:"since"`
	Started   time.Time `json:"started,omitempty"`
	Critical  bool      `json:"critical"`
	OneShot   bool      `json:"one_shot"`
	// Held is true while an operator has stopped it on purpose.
	Held bool `json:"held"`
}

// Running reports whether a process with this state has a live child.
func (s Status) Running() bool {
	return s.State == StateStarting || s.State == StateHealthy
}

// Tuning is the timing policy.
type Tuning struct {
	HealthInterval time.Duration
	HealthTimeout  time.Duration
	HealthRetries  int
	StartPeriod    time.Duration // failing probes do not count during it
	RestartBase    time.Duration
	RestartMax     time.Duration
	RestartReset   time.Duration // healthy this long → backoff starts over
	MaxRestarts    int           // 0 = unlimited (an unattended appliance)
	StopGrace      time.Duration // polite stop → kill
	KillGrace      time.Duration
	GateInterval   time.Duration
}

// DefaultTuning. StartPeriod is sized for the slowest start: a Python service
// importing its whole dependency tree on a cold disk.
func DefaultTuning() Tuning {
	return Tuning{
		HealthInterval: 5 * time.Second,
		HealthTimeout:  4 * time.Second,
		HealthRetries:  6,
		StartPeriod:    180 * time.Second,
		RestartBase:    time.Second,
		RestartMax:     60 * time.Second,
		RestartReset:   10 * time.Minute,
		StopGrace:      30 * time.Second,
		KillGrace:      15 * time.Second,
		GateInterval:   30 * time.Second,
	}
}

// Supervisor runs a set of Procs.
type Supervisor struct {
	log     *slog.Logger
	tun     Tuning
	spawner Spawner
	now     func() time.Time

	seq    []*runner
	byName map[string]*runner
	levels [][]*runner

	running atomic.Bool
	abort   chan struct{}
	once    sync.Once
	mu      sync.Mutex
	exitErr error
}

// New validates names and dependencies (unknown, self, cycles).
func New(procs []Proc, log *slog.Logger) (*Supervisor, error) {
	if len(procs) == 0 {
		return nil, errors.New("supervise: no processes")
	}
	if log == nil {
		log = slog.Default()
	}
	s := &Supervisor{
		log:     log,
		tun:     DefaultTuning(),
		spawner: ExecSpawner{},
		now:     time.Now,
		byName:  map[string]*runner{},
		abort:   make(chan struct{}),
	}
	for i := range procs {
		p := procs[i]
		if err := s.checkProc(i, p); err != nil {
			return nil, err
		}
		p.Args = append([]string(nil), p.Args...)
		p.Env = append([]string(nil), p.Env...)
		p.DependsOn = append([]string(nil), p.DependsOn...)
		r := newRunner(s, p)
		s.byName[p.Name] = r
		s.seq = append(s.seq, r)
	}
	for _, r := range s.seq {
		if err := s.linkDeps(r); err != nil {
			return nil, err
		}
	}
	lv, err := levels(s.seq)
	if err != nil {
		return nil, err
	}
	s.levels = lv
	return s, nil
}

// checkProc refuses a process the table cannot run: no name, a name taken
// already, or nothing to execute.
func (s *Supervisor) checkProc(i int, p Proc) error {
	if strings.TrimSpace(p.Name) == "" {
		return fmt.Errorf("supervise: process %d has no name", i)
	}
	if _, dup := s.byName[p.Name]; dup {
		return fmt.Errorf("supervise: duplicate process %q", p.Name)
	}
	if strings.TrimSpace(p.Exe) == "" {
		return fmt.Errorf("supervise: process %q has no executable", p.Name)
	}
	return nil
}

// linkDeps resolves r's DependsOn names; cycles are levels' job.
func (s *Supervisor) linkDeps(r *runner) error {
	for _, d := range r.spec.DependsOn {
		dr, ok := s.byName[d]
		if !ok {
			return fmt.Errorf("supervise: %q depends on unknown %q", r.spec.Name, d)
		}
		if dr == r {
			return fmt.Errorf("supervise: %q depends on itself", d)
		}
		r.deps = append(r.deps, dr)
	}
	return nil
}

// SetTuning / SetSpawner / SetClock are test seams; call before Run.
func (s *Supervisor) SetTuning(t Tuning) {
	if !s.running.Load() {
		s.tun = t
	}
}
func (s *Supervisor) SetSpawner(sp Spawner) {
	if !s.running.Load() && sp != nil {
		s.spawner = sp
	}
}
func (s *Supervisor) SetClock(now func() time.Time) {
	if !s.running.Load() && now != nil {
		s.now = now
	}
}

// Run starts everything and returns once ctx is done (or a critical process
// gave up) AND every child is gone: the SCM considers the service stopped when
// this returns, so postgres must not still be checkpointing.
func (s *Supervisor) Run(ctx context.Context) error {
	if !s.running.CompareAndSwap(false, true) {
		return errors.New("supervise: Run called twice")
	}
	s.log.Info("supervisor starting", "processes", len(s.seq), "levels", len(s.levels))
	var wg sync.WaitGroup
	for _, r := range s.seq {
		wg.Add(1)
		go func(r *runner) {
			defer wg.Done()
			r.run()
		}(r)
	}
	select {
	case <-ctx.Done():
		s.log.Info("supervisor stopping", "reason", "requested")
	case <-s.abort:
		s.log.Error("supervisor stopping", "reason", "a critical process gave up")
	}
	s.shutdown()
	wg.Wait()
	s.log.Info("supervisor stopped")
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exitErr
}

// shutdown stops level by level, deepest first, so postgres and nats go last.
func (s *Supervisor) shutdown() {
	for i := len(s.levels) - 1; i >= 0; i-- {
		var wg sync.WaitGroup
		for _, r := range s.levels[i] {
			wg.Add(1)
			go func(r *runner) {
				defer wg.Done()
				r.shutdown()
			}(r)
		}
		wg.Wait()
	}
}

// Status lists every process in declaration order.
func (s *Supervisor) Status() []Status {
	out := make([]Status, 0, len(s.seq))
	for _, r := range s.seq {
		out = append(out, r.status())
	}
	return out
}

// ErrUnknown is returned by the operator controls for a name that is not a process.
var ErrUnknown = errors.New("no such process")

// Restart stops a process (if running) and starts it again; a held process is
// released. For a one-shot this re-runs it.
func (s *Supervisor) Restart(name string) error { return s.control(name, cmdRestart) }

// Stop holds a process stopped until Start (or the service restarts).
func (s *Supervisor) Stop(name string) error { return s.control(name, cmdStop) }

// Start releases a held process.
func (s *Supervisor) Start(name string) error { return s.control(name, cmdStart) }

func (s *Supervisor) control(name string, c command) error {
	r, ok := s.byName[name]
	if !ok {
		return ErrUnknown
	}
	return r.send(c)
}

func (s *Supervisor) giveUp(name string, critical bool, why string) {
	if !critical {
		return
	}
	s.mu.Lock()
	if s.exitErr == nil {
		s.exitErr = fmt.Errorf("critical process %q gave up: %s", name, why)
	}
	s.mu.Unlock()
	s.once.Do(func() { close(s.abort) })
}

// levels groups runners by dependency depth, rejecting cycles.
func levels(seq []*runner) ([][]*runner, error) {
	const (
		onPath  = 1
		settled = 2
	)
	mark := map[*runner]int{}
	depth := map[*runner]int{}
	var visit func(r *runner, path []string) (int, error)
	visit = func(r *runner, path []string) (int, error) {
		switch mark[r] {
		case onPath:
			return 0, fmt.Errorf("supervise: dependency cycle %s", strings.Join(append(path, r.spec.Name), " -> "))
		case settled:
			return depth[r], nil
		}
		mark[r] = onPath
		d := 0
		for _, dep := range r.deps {
			dd, err := visit(dep, append(path, r.spec.Name))
			if err != nil {
				return 0, err
			}
			if dd+1 > d {
				d = dd + 1
			}
		}
		mark[r] = settled
		depth[r] = d
		return d, nil
	}
	deepest := 0
	for _, r := range seq {
		d, err := visit(r, nil)
		if err != nil {
			return nil, err
		}
		if d > deepest {
			deepest = d
		}
	}
	out := make([][]*runner, deepest+1)
	for _, r := range seq {
		out[depth[r]] = append(out[depth[r]], r)
	}
	return out, nil
}
