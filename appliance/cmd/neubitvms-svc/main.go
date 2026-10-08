// neubitvms-svc is the Neubit VMS native appliance: the Windows Service that runs
// the whole VMS server (see docs/WINDOWS_NATIVE_APPLIANCE.md), and the verbs the
// installer and the desktop app use to manage it.
//
//	run            run the stack (what the service executes; Ctrl+C in a console)
//	provision      first-install / upgrade preparation of the data root (elevated)
//	install        register the Windows Service and seal the data root (elevated)
//	uninstall      stop and unregister the service; data is kept (elevated)
//	start|stop|restart   control the service (elevated)
//	status         service state + the running stack's /v1/status
//	ports          the effective port plan
//	proc <restart|stop|start> <name>   control one process of the running stack
//	serve-tiles    the basemap server (a supervised child of `run`)
//	version
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/neubit/vms-appliance/internal/acl"
	"github.com/neubit/vms-appliance/internal/control"
	"github.com/neubit/vms-appliance/internal/layout"
	"github.com/neubit/vms-appliance/internal/pgboot"
	"github.com/neubit/vms-appliance/internal/render"
	"github.com/neubit/vms-appliance/internal/secrets"
	"github.com/neubit/vms-appliance/internal/stack"
	"github.com/neubit/vms-appliance/internal/supervise"
	"github.com/neubit/vms-appliance/internal/tiles"
	"github.com/neubit/vms-appliance/internal/winsvc"
)

// version is stamped at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	verb, args := os.Args[1], os.Args[2:]
	var err error
	switch verb {
	case "run":
		err = cmdRun(args)
	case "provision":
		err = cmdProvision(args)
	case "install":
		err = cmdInstall(args)
	case "uninstall":
		err = winsvc.Uninstall()
	case "start", "stop", "restart":
		err = winsvc.Control(verb)
	case "status":
		err = cmdStatus(args)
	case "ports":
		err = cmdPorts(args)
	case "proc":
		err = cmdProc(args)
	case "serve-tiles":
		err = cmdServeTiles(args)
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", verb)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "neubitvms-svc:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: neubitvms-svc <command> [flags]

  run          run the VMS server (the Windows Service runs this)
  provision    prepare the data root: dirs, config, secrets, first admin (elevated)
  install      register the NeubitVMS service and seal the data root (elevated)
  uninstall    stop and unregister the service (data is kept)
  start | stop | restart
  status       service state and every process
  ports        the effective port plan
  proc restart|stop|start <name>
  version
`)
}

// rootFlag is shared by every verb that touches the data root.
func rootFlag(fs *flag.FlagSet) *string {
	return fs.String("root", "", "data root (default: registry DataRoot, then %ProgramData%\\Neubit\\VMS)")
}

func load(root string) (layout.Layout, layout.Config, layout.Ports, error) {
	l, err := layout.New(layout.ResolveRoot(root), "")
	if err != nil {
		return layout.Layout{}, layout.Config{}, layout.Ports{}, err
	}
	cfg, err := layout.LoadConfig(l.ConfigFile())
	if err != nil {
		return l, cfg, layout.Ports{}, err
	}
	p, err := cfg.Ports()
	return l, cfg, p, err
}

// ── run ──────────────────────────────────────────────────────────────────────

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	root := rootFlag(fs)
	_ = fs.Parse(args)
	return winsvc.Run(winsvc.Name, func(ctx context.Context) error { return run(ctx, *root) })
}

func run(ctx context.Context, root string) error {
	l, cfg, ports, err := load(root)
	if err != nil {
		return err
	}
	for _, d := range l.DataDirs() {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	logw, err := supervise.OpenLog(filepath.Join(l.LogDir(), "neubitvms-svc.log"))
	if err != nil {
		return err
	}
	defer logw.Close()
	var out io.Writer = logw
	if !winsvc.IsService() {
		out = io.MultiWriter(logw, os.Stderr)
	}
	// No time= attribute: the log file stamps every line itself (that stamp is
	// what Tail's since filter reads), and two clocks per line is noise.
	log := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	}))
	log.Info("neubitvms-svc starting", "version", version, "root", l.Root, "payload", l.ServerDir)

	if missing := layout.Missing(l.Python(), l.Postgres(), l.NATSServer(), l.Traefik(), l.Node()); len(missing) > 0 {
		err := fmt.Errorf("runtimes missing (re-run the installer to fetch them): %s", strings.Join(missing, ", "))
		log.Error("cannot start", "err", err)
		return err
	}

	sec, err := secrets.Ensure(l)
	if err != nil {
		return fmt.Errorf("secrets: %w", err)
	}
	if len(sec.Added) > 0 {
		log.Info("generated secrets", "keys", strings.Join(sec.Added, ","))
	}

	// Configs rendered from the payload's copies of the repo's own files.
	natsTpl, err := os.ReadFile(filepath.Join(l.TemplatesDir(), "nats", "nats.conf"))
	if err != nil {
		return err
	}
	natsConf, err := render.NATS(string(natsTpl), l.NATSDir(), ports)
	if err != nil {
		return err
	}
	natsPath := filepath.Join(l.RenderedDir(), "nats.conf")
	if err := layout.WriteFileAtomic(natsPath, []byte(natsConf), 0o600); err != nil {
		return err
	}
	gwStatic, err := render.Gateway(filepath.Join(l.TemplatesDir(), "gateway"), filepath.Join(l.RenderedDir(), "gateway"), ports, cfg.NVRURL)
	if err != nil {
		return fmt.Errorf("gateway config: %w", err)
	}

	dbs, err := pgboot.ServiceDatabases(filepath.Join(l.TemplatesDir(), "postgres", "init-service-dbs.sh"))
	if err != nil {
		return err
	}
	created, err := pgboot.EnsureCluster(ctx, pgboot.Options{
		BinDir: l.PGBin(), DataDir: l.PGData(), Port: ports.Postgres,
		User: sec.Get("POSTGRES_USER"), Password: sec.Get("POSTGRES_PASSWORD"),
		ControlDB: stack.ControlDB, Databases: dbs,
	})
	if err != nil {
		log.Error("database bootstrap failed", "err", err)
		return err
	}
	if created {
		log.Info("database cluster created", "dir", l.PGData())
	}

	self, _ := os.Executable()
	host, _ := os.Hostname()
	in := stack.Input{
		L: l, Cfg: cfg, Ports: ports, Secrets: sec.Values, SelfExe: self,
		Gateway: gwStatic, NATSConf: natsPath, Hostname: host,
	}
	sup, err := supervise.New(stack.Procs(in), log)
	if err != nil {
		return err
	}

	uiURL := "http://127.0.0.1"
	lanHost := cfg.AdvertiseHost
	if lanHost == "" {
		lanHost = host
	}
	lanURL := "http://" + lanHost
	if ports.UI != 80 {
		uiURL = fmt.Sprintf("%s:%d", uiURL, ports.UI)
		lanURL = fmt.Sprintf("%s:%d", lanURL, ports.UI)
	}
	ctl := control.New(control.Options{
		Sup: sup, L: l, Ports: ports, Token: sec.Get("OPS_AGENT_TOKEN"),
		PGUser: sec.Get("POSTGRES_USER"), PGPassword: sec.Get("POSTGRES_PASSWORD"),
		Version: version, UIURL: uiURL, LANURL: lanURL, Started: time.Now(),
	})

	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := ctl.Listen(cctx); err != nil {
			log.Error("control API stopped", "err", err)
		}
	}()
	err = sup.Run(cctx)
	cancel()
	wg.Wait()
	log.Info("neubitvms-svc stopped", "err", err)
	return err
}

// ── provision / install ──────────────────────────────────────────────────────

type provisionFlags struct {
	root, installDir, ports, runtimeEnv, license, adminEmail, adminPassword, nvrURL *string
}

func cmdProvision(args []string) error {
	fs := flag.NewFlagSet("provision", flag.ExitOnError)
	f := provisionFlags{
		root:          rootFlag(fs),
		installDir:    fs.String("install-dir", "", "program directory; a non-Windows drive moves the data root there"),
		ports:         fs.String("ports", "", `port overrides, e.g. "ui=8090"`),
		runtimeEnv:    fs.String("runtime-env", "", "dev or prod (prod needs -license)"),
		license:       fs.String("license", "", "signed licence token"),
		adminEmail:    fs.String("admin-email", "", "unattended installs only: create the first administrator from here instead of the console's first-run setup"),
		adminPassword: fs.String("admin-password", "", "with -admin-email: its password (generated into the data root's config folder when empty)"),
		nvrURL:        fs.String("nvr-url", "", "a Neubit NVR on this machine, e.g. http://127.0.0.1:8000"),
	}
	_ = fs.Parse(args)
	// Before anything is written: a refused address must not leave a half
	// provisioned data root behind.
	if *f.adminEmail != "" {
		if err := secrets.CheckAdminEmail(*f.adminEmail); err != nil {
			return err
		}
	}

	l, err := layout.New(provisionRoot(*f.root, *f.installDir), "")
	if err != nil {
		return err
	}
	for _, d := range l.DataDirs() {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	cfg, err := provisionConfig(l, f)
	if err != nil {
		return err
	}
	sec, err := secrets.Ensure(l)
	if err != nil {
		return err
	}
	if *f.license != "" {
		if err := secrets.Set(l, "VE_LICENSE_TOKEN", *f.license); err != nil {
			return err
		}
	}
	// The first administrator. Normally NOT here: the operator creates it in the
	// console's first-run setup, on this computer (core's setup_local_only), so
	// no password is ever written to disk. -admin-email is for an unattended
	// install, where core creates it from these on its first boot.
	if sec.Get("VE_BOOTSTRAP_ADMIN_EMAIL") == "" {
		if *f.adminEmail != "" {
			if err := provisionAdmin(l, *f.adminEmail, *f.adminPassword); err != nil {
				return err
			}
		} else {
			fmt.Println("first administrator: created in the console's first-run setup, on this computer")
		}
	}
	if err := layout.WriteRegistryRoot(l.Root); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not record the data root in the registry: %v\n", err)
	}
	p, _ := cfg.Ports()
	fmt.Printf("data root: %s\nconsole port: %d\n", l.Root, p.UI)
	return nil
}

// provisionRoot: an explicit -root wins; otherwise the recorded or default
// root, except that a first install off the Windows drive keeps its data on
// that drive.
func provisionRoot(root, installDir string) string {
	if root != "" {
		return root
	}
	r := layout.ResolveRoot("")
	if installDir != "" && r == layout.DefaultRoot() {
		r = layout.RootForInstallDir(installDir)
	}
	return r
}

// provisionConfig merges the flags into config.json. A flag left empty keeps
// what an earlier install chose, so an upgrade does not reset them.
func provisionConfig(l layout.Layout, f provisionFlags) (layout.Config, error) {
	cfg, err := layout.LoadConfig(l.ConfigFile())
	if err != nil {
		return cfg, err
	}
	for _, o := range []struct {
		flag string
		dst  *string
	}{{*f.ports, &cfg.PortOverrides}, {*f.runtimeEnv, &cfg.RuntimeEnv}, {*f.nvrURL, &cfg.NVRURL}} {
		if o.flag != "" {
			*o.dst = o.flag
		}
	}
	if cfg.RuntimeEnv == "prod" && *f.license == "" {
		s, _ := secrets.Load(l.SecretsFile())
		if s.Values["VE_LICENSE_TOKEN"] == "" {
			return cfg, errors.New("-runtime-env prod needs -license: core refuses prod without a signed licence")
		}
	}
	return cfg, layout.SaveConfig(l.ConfigFile(), cfg)
}

// provisionAdmin records an unattended install's first administrator,
// generating the password when none is given, and leaves it in a file only
// Administrators can read.
func provisionAdmin(l layout.Layout, email, pw string) error {
	if err := secrets.CheckAdminEmail(email); err != nil {
		return err
	}
	if pw == "" {
		r, err := secrets.Random(16)
		if err != nil {
			return err
		}
		pw = "Nb@" + r
	}
	if err := secrets.Set(l, "VE_BOOTSTRAP_ADMIN_EMAIL", email); err != nil {
		return err
	}
	if err := secrets.Set(l, "VE_BOOTSTRAP_ADMIN_PASSWORD", pw); err != nil {
		return err
	}
	note := fmt.Sprintf("Neubit VMS - first administrator\r\n\r\nEmail:    %s\r\nPassword: %s\r\n\r\n"+
		"Sign in and change this password. Delete this file afterwards.\r\n", email, pw)
	if err := layout.WriteFileAtomic(l.AdminFile(), []byte(note), 0o600); err != nil {
		return err
	}
	fmt.Printf("first administrator: %s (password written to %s)\n", email, l.AdminFile())
	return nil
}

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	root := rootFlag(fs)
	_ = fs.Parse(args)
	self, err := os.Executable()
	if err != nil {
		return err
	}
	l, _, _, err := load(*root)
	if err != nil {
		return err
	}
	svcArgs := []string{"run"}
	if *root != "" {
		svcArgs = append(svcArgs, "-root", l.Root)
	}
	if err := winsvc.Install(self, svcArgs); err != nil {
		return err
	}
	// After registration: the virtual account exists only once the service does.
	if err := acl.SealDataRoot(l.Root, winsvc.VirtualAccount(winsvc.Name)); err != nil {
		return fmt.Errorf("sealing the data root: %w", err)
	}
	fmt.Printf("service %s installed; data root %s sealed to SYSTEM, Administrators and %s\n",
		winsvc.Name, l.Root, winsvc.VirtualAccount(winsvc.Name))
	return nil
}

// ── status / ports / proc ────────────────────────────────────────────────────

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	root := rootFlag(fs)
	asJSON := fs.Bool("json", false, "print /v1/status as JSON")
	wait := fs.Duration("wait-ready", 0, "wait up to this long for the stack to report ready")
	_ = fs.Parse(args)
	_, _, ports, err := load(*root)
	if err != nil {
		return err
	}
	st, err := waitStatus(ports.Control, *wait)
	if *asJSON {
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(st)
	}
	fmt.Printf("service: %s\n", winsvc.Query())
	if err != nil {
		fmt.Printf("stack:   not answering (%v)\n", err)
		if *wait > 0 {
			return errors.New("the stack did not become ready")
		}
		return nil
	}
	printStatus(st)
	if *wait > 0 && !st.Ready {
		return errors.New("the stack did not become ready")
	}
	return nil
}

// waitStatus polls /v1/status until the stack is ready or wait runs out; a
// zero wait is one read.
func waitStatus(port int, wait time.Duration) (control.Status, error) {
	deadline := time.Now().Add(wait)
	for {
		st, err := fetchStatus(port)
		if (err == nil && (st.Ready || wait == 0)) || time.Now().After(deadline) {
			return st, err
		}
		time.Sleep(2 * time.Second)
	}
}

func printStatus(st control.Status) {
	fmt.Printf("stack:   %d/%d healthy, ready=%v\nconsole: %s  (LAN: %s)\n\n", st.Healthy, st.Total, st.Ready, st.UIURL, st.LANURL)
	for _, p := range st.Processes {
		line := fmt.Sprintf("  %-18s %-11s", p.Name, p.State)
		if p.PID > 0 {
			line += fmt.Sprintf(" pid %-6d", p.PID)
		}
		if p.Restarts > 0 {
			line += fmt.Sprintf(" restarts %d", p.Restarts)
		}
		if p.LastError != "" {
			line += "  " + p.LastError
		}
		fmt.Println(line)
	}
}

func fetchStatus(port int) (control.Status, error) {
	var st control.Status
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/status", port))
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	return st, json.NewDecoder(resp.Body).Decode(&st)
}

func cmdPorts(args []string) error {
	fs := flag.NewFlagSet("ports", flag.ExitOnError)
	root := rootFlag(fs)
	_ = fs.Parse(args)
	_, _, p, err := load(*root)
	if err != nil {
		return err
	}
	for _, n := range p.Names() {
		v, _ := p.Get(n)
		fmt.Printf("%s=%d\n", n, v)
	}
	return nil
}

func cmdProc(args []string) error {
	fs := flag.NewFlagSet("proc", flag.ExitOnError)
	root := rootFlag(fs)
	_ = fs.Parse(args)
	if fs.NArg() != 2 {
		return errors.New("usage: proc restart|stop|start <name>")
	}
	verb, name := fs.Arg(0), fs.Arg(1)
	l, _, p, err := load(*root)
	if err != nil {
		return err
	}
	sec, err := secrets.Load(l.SecretsFile())
	if err != nil {
		return fmt.Errorf("reading the ops token (run elevated): %w", err)
	}
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/containers/%s/%s", p.Control, name, verb), nil)
	req.Header.Set("X-Ops-Token", sec.Get("OPS_AGENT_TOKEN"))
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s %s: %s", verb, name, strings.TrimSpace(string(b)))
	}
	fmt.Printf("%s %s: ok\n", verb, name)
	return nil
}

func cmdServeTiles(args []string) error {
	fs := flag.NewFlagSet("serve-tiles", flag.ExitOnError)
	dir := fs.String("dir", "", "directory holding planet.pmtiles")
	port := fs.Int("port", 18080, "loopback port")
	_ = fs.Parse(args)
	if *dir == "" {
		return errors.New("-dir is required")
	}
	return tiles.Serve(*dir, *port)
}
