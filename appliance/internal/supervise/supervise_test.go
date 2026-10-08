package supervise

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeChild exits when told to, or when signalled (if it honours signals).
type fakeChild struct {
	pid      int
	exit     chan error
	ignoreSg bool
	killed   bool
	mu       sync.Mutex
	once     sync.Once
}

func (c *fakeChild) PID() int    { return c.pid }
func (c *fakeChild) Wait() error { return <-c.exit }
func (c *fakeChild) end(err error) {
	c.once.Do(func() { c.exit <- err })
}
func (c *fakeChild) Signal() error {
	if !c.ignoreSg {
		c.end(nil)
	}
	return nil
}
func (c *fakeChild) Kill() error {
	c.mu.Lock()
	c.killed = true
	c.mu.Unlock()
	c.end(errors.New("killed"))
	return nil
}

type fakeSpawner struct {
	mu      sync.Mutex
	started []string
	stopped []string
	live    map[string]*fakeChild
	pid     int
	// onStart lets a test decide how a process behaves when started.
	onStart func(name string, c *fakeChild)
}

func newFake() *fakeSpawner { return &fakeSpawner{live: map[string]*fakeChild{}} }

func (f *fakeSpawner) Start(p Proc, _, _ io.Writer) (Child, error) {
	f.mu.Lock()
	f.pid++
	c := &fakeChild{pid: f.pid, exit: make(chan error, 1)}
	f.started = append(f.started, p.Name)
	f.live[p.Name] = c
	hook := f.onStart
	f.mu.Unlock()
	if hook != nil {
		hook(p.Name, c)
	}
	// Wrap so the order of stops is recorded.
	return &recordingChild{fakeChild: c, f: f, name: p.Name}, nil
}

type recordingChild struct {
	*fakeChild
	f    *fakeSpawner
	name string
}

func (r *recordingChild) Wait() error {
	err := <-r.fakeChild.exit
	return err
}

func (r *recordingChild) Signal() error {
	r.f.mu.Lock()
	r.f.stopped = append(r.f.stopped, r.name)
	r.f.mu.Unlock()
	return r.fakeChild.Signal()
}

func (f *fakeSpawner) startedNames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.started...)
}

func (f *fakeSpawner) child(name string) *fakeChild {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.live[name]
}

func fastTuning() Tuning {
	return Tuning{
		HealthInterval: 5 * time.Millisecond,
		HealthTimeout:  5 * time.Millisecond,
		HealthRetries:  2,
		StartPeriod:    20 * time.Millisecond,
		RestartBase:    5 * time.Millisecond,
		RestartMax:     20 * time.Millisecond,
		RestartReset:   time.Hour,
		StopGrace:      50 * time.Millisecond,
		KillGrace:      50 * time.Millisecond,
		GateInterval:   5 * time.Millisecond,
	}
}

func start(t *testing.T, procs []Proc, f *fakeSpawner, tun Tuning) (*Supervisor, context.CancelFunc, chan error) {
	t.Helper()
	s, err := New(procs, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.SetSpawner(f)
	s.SetTuning(tun)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	return s, cancel, done
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func stateOf(s *Supervisor, name string) State {
	for _, st := range s.Status() {
		if st.Name == name {
			return st.State
		}
	}
	return ""
}

func TestRejectsUnknownDependencyAndCycles(t *testing.T) {
	if _, err := New([]Proc{{Name: "a", Exe: "x", DependsOn: []string{"nope"}}}, nil); err == nil {
		t.Fatal("unknown dependency accepted")
	}
	_, err := New([]Proc{
		{Name: "a", Exe: "x", DependsOn: []string{"b"}},
		{Name: "b", Exe: "x", DependsOn: []string{"a"}},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("cycle not rejected: %v", err)
	}
}

func TestStartsInDependencyOrderAndStopsInReverse(t *testing.T) {
	f := newFake()
	procs := []Proc{
		{Name: "gateway", Exe: "x", DependsOn: []string{"core"}},
		{Name: "core", Exe: "x", DependsOn: []string{"postgres"}},
		{Name: "postgres", Exe: "x"},
	}
	s, cancel, done := start(t, procs, f, fastTuning())
	waitFor(t, "all healthy", func() bool { return stateOf(s, "gateway") == StateHealthy })
	if got := f.startedNames(); strings.Join(got, ",") != "postgres,core,gateway" {
		t.Fatalf("start order %v", got)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	order := strings.Join(f.stopped, ",")
	f.mu.Unlock()
	if order != "gateway,core,postgres" {
		t.Fatalf("stop order %s", order)
	}
}

func TestDependentsWaitForAOneShotToComplete(t *testing.T) {
	// A service must never start on an unmigrated schema.
	f := newFake()
	release := make(chan struct{})
	f.onStart = func(name string, c *fakeChild) {
		if name == "migrate" {
			go func() { <-release; c.end(nil) }()
		}
	}
	procs := []Proc{
		{Name: "migrate", Exe: "x", OneShot: true},
		{Name: "core", Exe: "x", DependsOn: []string{"migrate"}},
	}
	s, cancel, done := start(t, procs, f, fastTuning())
	defer func() { cancel(); <-done }()
	time.Sleep(30 * time.Millisecond)
	if stateOf(s, "core") != StatePending {
		t.Fatalf("core started before migrations finished: %v", f.startedNames())
	}
	close(release)
	waitFor(t, "core healthy", func() bool { return stateOf(s, "core") == StateHealthy })
	if stateOf(s, "migrate") != StateCompleted {
		t.Fatalf("migrate state %s", stateOf(s, "migrate"))
	}
}

func TestAFailedOneShotIsRetriedNotTreatedAsDone(t *testing.T) {
	f := newFake()
	var n int
	var mu sync.Mutex
	f.onStart = func(name string, c *fakeChild) {
		mu.Lock()
		n++
		attempt := n
		mu.Unlock()
		go func() {
			if attempt < 3 {
				c.end(errors.New("exit 1"))
			} else {
				c.end(nil)
			}
		}()
	}
	s, cancel, done := start(t, []Proc{{Name: "migrate", Exe: "x", OneShot: true}}, f, fastTuning())
	defer func() { cancel(); <-done }()
	waitFor(t, "completed", func() bool { return stateOf(s, "migrate") == StateCompleted })
	if got := s.Status()[0].Restarts; got != 2 {
		t.Fatalf("restarts %d, want 2", got)
	}
}

func TestACrashedProcessIsRestarted(t *testing.T) {
	f := newFake()
	s, cancel, done := start(t, []Proc{{Name: "core", Exe: "x"}}, f, fastTuning())
	defer func() { cancel(); <-done }()
	waitFor(t, "healthy", func() bool { return stateOf(s, "core") == StateHealthy })
	f.child("core").end(errors.New("boom"))
	waitFor(t, "restarted", func() bool { return len(f.startedNames()) == 2 && stateOf(s, "core") == StateHealthy })
}

func TestAProcessFailingHealthIsRestarted(t *testing.T) {
	f := newFake()
	var healthy sync.Map
	health := func(context.Context) error {
		if _, ok := healthy.Load("core"); ok {
			return nil
		}
		return errors.New("refused")
	}
	tun := fastTuning()
	tun.StartPeriod = 0
	s, cancel, done := start(t, []Proc{{Name: "core", Exe: "x", Health: health}}, f, tun)
	defer func() { cancel(); <-done }()
	waitFor(t, "a restart", func() bool { return len(f.startedNames()) >= 2 })
	healthy.Store("core", true)
	waitFor(t, "healthy", func() bool { return stateOf(s, "core") == StateHealthy })
}

func TestAStartPeriodRefusalIsClearedOnceHealthy(t *testing.T) {
	// A healthy gateway showing "starting: ... refused" reads as a fault.
	f := newFake()
	var up atomic.Bool
	health := func(context.Context) error {
		if up.Load() {
			return nil
		}
		return errors.New("refused")
	}
	tun := fastTuning()
	tun.StartPeriod = time.Hour
	s, cancel, done := start(t, []Proc{{Name: "gateway", Exe: "x", Health: health}}, f, tun)
	defer func() { cancel(); <-done }()
	waitFor(t, "a start-period refusal", func() bool { return strings.HasPrefix(s.Status()[0].LastError, startingPrefix) })
	up.Store(true)
	waitFor(t, "healthy", func() bool { return stateOf(s, "gateway") == StateHealthy })
	waitFor(t, "error cleared", func() bool { return s.Status()[0].LastError == "" })
}

func TestOperatorStopHoldsUntilStart(t *testing.T) {
	f := newFake()
	s, cancel, done := start(t, []Proc{{Name: "vision", Exe: "x"}}, f, fastTuning())
	defer func() { cancel(); <-done }()
	waitFor(t, "healthy", func() bool { return stateOf(s, "vision") == StateHealthy })
	if err := s.Stop("vision"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "held", func() bool { return stateOf(s, "vision") == StateStopped })
	time.Sleep(30 * time.Millisecond)
	if len(f.startedNames()) != 1 {
		t.Fatal("a held process was restarted")
	}
	if err := s.Start("vision"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "running again", func() bool { return stateOf(s, "vision") == StateHealthy && len(f.startedNames()) == 2 })
}

func TestStartOnARunningProcessDoesNothing(t *testing.T) {
	f := newFake()
	s, cancel, done := start(t, []Proc{{Name: "core", Exe: "x"}}, f, fastTuning())
	defer func() { cancel(); <-done }()
	waitFor(t, "healthy", func() bool { return stateOf(s, "core") == StateHealthy })
	_ = s.Start("core")
	time.Sleep(30 * time.Millisecond)
	if n := len(f.startedNames()); n != 1 {
		t.Fatalf("Start on a running process restarted it (%d starts)", n)
	}
}

func TestOperatorRestart(t *testing.T) {
	f := newFake()
	s, cancel, done := start(t, []Proc{{Name: "core", Exe: "x"}}, f, fastTuning())
	defer func() { cancel(); <-done }()
	waitFor(t, "healthy", func() bool { return stateOf(s, "core") == StateHealthy })
	if err := s.Restart("core"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "restarted", func() bool { return len(f.startedNames()) == 2 && stateOf(s, "core") == StateHealthy })
	if s.Restart("nope") != ErrUnknown {
		t.Fatal("unknown process accepted")
	}
}

func TestAGatedProcessWaitsForItsData(t *testing.T) {
	f := newFake()
	var ready sync.Map
	gate := func() error {
		if _, ok := ready.Load("x"); ok {
			return nil
		}
		return errors.New("no geocoder index yet")
	}
	s, cancel, done := start(t, []Proc{{Name: "geocoder", Exe: "x", Gate: gate}}, f, fastTuning())
	defer func() { cancel(); <-done }()
	waitFor(t, "waiting", func() bool { return stateOf(s, "geocoder") == StateWaiting })
	if len(f.startedNames()) != 0 {
		t.Fatal("started before its gate opened")
	}
	ready.Store("x", true)
	waitFor(t, "healthy", func() bool { return stateOf(s, "geocoder") == StateHealthy })
}

func TestAChildIgnoringTheStopIsKilled(t *testing.T) {
	f := newFake()
	f.onStart = func(_ string, c *fakeChild) { c.ignoreSg = true }
	s, cancel, done := start(t, []Proc{{Name: "stubborn", Exe: "x"}}, f, fastTuning())
	waitFor(t, "healthy", func() bool { return stateOf(s, "stubborn") == StateHealthy })
	cancel()
	<-done
	c := f.child("stubborn")
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.killed {
		t.Fatal("not killed after the stop grace")
	}
}

func TestBackoffDoublesToTheCap(t *testing.T) {
	tun := Tuning{RestartBase: time.Second, RestartMax: 8 * time.Second}
	want := []time.Duration{1, 2, 4, 8, 8}
	for i, w := range want {
		if got := backoff(tun, i+1); got != w*time.Second {
			t.Fatalf("attempt %d: %v want %v", i+1, got, w*time.Second)
		}
	}
}

func TestLogLinesAreTimestampedAndTailFiltersBySince(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "core.log")
	l, err := OpenLog(path)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)
	now := t0
	l.now = func() time.Time { return now }
	_, _ = l.Write([]byte("first\nsec"))
	now = t0.Add(time.Minute)
	_, _ = l.Write([]byte("ond\r\nthird\n"))
	_ = l.Close()

	all, _ := Tail(path, 10, time.Time{})
	if len(all) != 3 || !strings.HasSuffix(all[0], " first") || !strings.HasSuffix(all[1], " second") {
		t.Fatalf("lines %q", all)
	}
	recent, _ := Tail(path, 10, t0.Add(30*time.Second))
	if len(recent) != 2 {
		t.Fatalf("since filter: %q", recent)
	}
	last, _ := Tail(path, 1, time.Time{})
	if len(last) != 1 || !strings.HasSuffix(last[0], " third") {
		t.Fatalf("tail 1: %q", last)
	}
}

func TestLogRotates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.log")
	l, _ := OpenLog(path)
	l.size = LogMaxBytes // next line rotates
	_, _ = l.Write([]byte("after rotation\n"))
	_ = l.Close()
	if _, err := os.Stat(filepath.Join(dir, "x.1.log")); err != nil {
		t.Fatal("no rotated file")
	}
}

func TestMergeEnvLaterWins(t *testing.T) {
	got := MergeEnv([]string{"A=1", "B=2"}, []string{"B=3", "C=4"})
	if strings.Join(got, ",") != "A=1,B=3,C=4" {
		t.Fatalf("%v", got)
	}
}
