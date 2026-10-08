// Package render turns the Docker stack's own gateway and bus configuration
// into the native appliance's, at every service start.
//
// The repo's files ARE the templates — gateway/traefik routes and middlewares,
// deploy/nats/nats.conf — shipped in the payload unchanged. Rendering only
// rewrites what differs between a compose network and one Windows host: the
// container addresses (http://core:8000 → http://127.0.0.1:18000), the listen
// addresses and the data paths. So a route, a middleware or a NATS permission
// added for Docker reaches the appliance with no second copy to forget, and any
// container address the table below does not know fails the render loudly
// instead of shipping a gateway that 502s.
package render

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/neubit/vms-appliance/internal/layout"
)

// Upstreams maps a compose service host to the native URL serving it.
type Upstreams map[string]string

// NativeUpstreams is the address table for this machine's port plan. The NVR
// and MediaMTX hosts point at a Neubit NVR installed on the same server (its
// own fixed loopback ports) — when there is none, those routes answer 502,
// which is what the Docker stack does without the recorder too.
func NativeUpstreams(p layout.Ports, nvrURL string) Upstreams {
	loop := func(port int) string { return fmt.Sprintf("http://127.0.0.1:%d", port) }
	if nvrURL == "" {
		nvrURL = "http://127.0.0.1:8000"
	}
	nvrHost := "127.0.0.1"
	if m := regexp.MustCompile(`^https?://([^:/]+)`).FindStringSubmatch(nvrURL); m != nil {
		nvrHost = m[1]
	}
	media := func(port int) string { return fmt.Sprintf("http://%s:%d", nvrHost, port) }
	u := Upstreams{
		"core:8000":           loop(p.Core),
		"ingest:8000":         loop(p.Ingest),
		"workflow:8000":       loop(p.Workflow),
		"access:8000":         loop(p.Access),
		"vision:8000":         loop(p.Vision),
		"reading-writer:8000": loop(p.ReadingWriter),
		"frontend:3000":       loop(p.Frontend),
		"admin-frontend:3000": loop(p.Admin),
		"tiles:80":            loop(p.Tiles),
		"geocoder:2322":       loop(p.Geocoder),
		"nvr:8000":            strings.TrimRight(nvrURL, "/"),
	}
	// One recorder on this host: every MediaMTX instance name maps to it.
	for _, h := range []string{"mediamtx", "mediamtx-2", "mediamtx-r1"} {
		u[h+":8888"] = media(8888)
		u[h+":8889"] = media(8889)
		u[h+":9996"] = media(9996)
	}
	return u
}

var hostRe = regexp.MustCompile(`http://([a-z][a-z0-9-]*):(\d+)`)

// RewriteUpstreams replaces every http://<service>:<port> in a dynamic config.
func RewriteUpstreams(src string, u Upstreams) (string, error) {
	var unknown []string
	out := hostRe.ReplaceAllStringFunc(src, func(m string) string {
		sm := hostRe.FindStringSubmatch(m)
		key := sm[1] + ":" + sm[2]
		if v, ok := u[key]; ok {
			return v
		}
		unknown = append(unknown, key)
		return m
	})
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return "", fmt.Errorf("gateway config names upstreams the appliance does not run: %s", strings.Join(dedupe(unknown), ", "))
	}
	return out, nil
}

func dedupe(s []string) []string {
	var out []string
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}

// TraefikStatic is the static configuration: one LAN entrypoint, the file
// provider on the rendered directory, no dashboard (nothing would protect it).
func TraefikStatic(uiPort int, dynamicDir string) string {
	return fmt.Sprintf(`# Neubit VMS appliance gateway - GENERATED at every service start; do not edit.
global:
  checkNewVersion: false
  sendAnonymousUsage: false
entryPoints:
  web:
    address: ":%d"
providers:
  file:
    directory: %q
    watch: false
api:
  dashboard: false
ping:
  entryPoint: web
log:
  level: INFO
accessLog: {}
`, uiPort, filepath.ToSlash(dynamicDir))
}

// Gateway renders traefik.yml and the dynamic directory into outDir.
// templatesDir is the payload's copy of the repo's gateway/ directory.
func Gateway(templatesDir, outDir string, p layout.Ports, nvrURL string) (staticPath string, err error) {
	dyn := filepath.Join(outDir, "dynamic")
	if err := os.RemoveAll(dyn); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dyn, 0o755); err != nil {
		return "", err
	}
	u := NativeUpstreams(p, nvrURL)
	entries, err := os.ReadDir(filepath.Join(templatesDir, "dynamic"))
	if err != nil {
		return "", err
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() || !(strings.HasSuffix(e.Name(), ".yml") || strings.HasSuffix(e.Name(), ".yaml")) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(templatesDir, "dynamic", e.Name()))
		if err != nil {
			return "", err
		}
		out, err := RewriteUpstreams(string(b), u)
		if err != nil {
			return "", fmt.Errorf("%s: %w", e.Name(), err)
		}
		header := "# GENERATED from the payload's gateway/dynamic/" + e.Name() + " - do not edit.\n"
		if err := layout.WriteFileAtomic(filepath.Join(dyn, e.Name()), []byte(header+out), 0o644); err != nil {
			return "", err
		}
		n++
	}
	if n == 0 {
		return "", fmt.Errorf("no gateway route files in %s", filepath.Join(templatesDir, "dynamic"))
	}
	staticPath = filepath.Join(outDir, "traefik.yml")
	return staticPath, layout.WriteFileAtomic(staticPath, []byte(TraefikStatic(p.UI, dyn)), 0o644)
}

var (
	storeDirRe = regexp.MustCompile(`(?m)^(\s*store_dir:\s*)"[^"]*"`)
	httpRe     = regexp.MustCompile(`(?m)^http:\s*\d+\s*$`)
)

// NATS renders nats.conf from the repo's: the JetStream store moves to the data
// root, the monitor and client ports bind loopback. The per-service users and
// their subject permissions are kept byte for byte; their passwords stay
// $NATS_PASS_* variables that the supervisor passes in the environment.
func NATS(template string, storeDir string, p layout.Ports) (string, error) {
	if !storeDirRe.MatchString(template) {
		return "", fmt.Errorf("nats.conf template: no jetstream store_dir to relocate")
	}
	if !httpRe.MatchString(template) {
		return "", fmt.Errorf("nats.conf template: no `http: <port>` monitor line")
	}
	// Forward slashes, whatever the host: %q would double every backslash, and
	// filepath.ToSlash is a no-op off Windows, so it cannot be trusted here.
	out := storeDirRe.ReplaceAllString(template, fmt.Sprintf(`${1}%q`, strings.ReplaceAll(storeDir, `\`, "/")))
	out = httpRe.ReplaceAllString(out, fmt.Sprintf(`http: "127.0.0.1:%d"`, p.NATSMonitor))
	head := fmt.Sprintf("# Neubit VMS appliance - GENERATED at every service start from deploy/nats/nats.conf.\n"+
		"server_name: neubit-vms\nlisten: \"127.0.0.1:%d\"\n\n", p.NATS)
	return head + out, nil
}
