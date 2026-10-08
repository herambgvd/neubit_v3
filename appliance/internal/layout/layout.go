// Package layout is where everything lives on a native VMS appliance: the data
// root and its directories, the installed payload, the runtimes, the port plan
// and the persisted configuration.
//
// Two roots, kept apart on purpose:
//
//   - the PAYLOAD (ServerDir) is what the installer lays down and an upgrade
//     replaces: neubitvms-svc.exe, the Python runtime, the services' source, the
//     web builds, the config templates. It is the directory neubitvms-svc.exe is
//     in (`<install>\resources\server`).
//   - the DATA ROOT is what an upgrade must never touch: the database, the event
//     store, files, logs, secrets, and the fetched runtimes. `%ProgramData%\Neubit\
//     VMS` by default, `<drive>:\NeubitVMS` when the program is installed off the
//     Windows drive (footage and databases follow the big disk, the NVR's rule).
package layout

import (
	"errors"
	"os"
	"path/filepath"
)

// EnvRoot overrides the data root (tests, a second instance, a support session).
const EnvRoot = "NEUBIT_VMS_ROOT"

// Layout resolves every path from the two roots.
type Layout struct {
	Root      string // data root
	ServerDir string // installed payload
}

// New builds a Layout. serverDir "" means the directory of the running binary.
func New(root, serverDir string) (Layout, error) {
	if serverDir == "" {
		exe, err := os.Executable()
		if err != nil {
			return Layout{}, err
		}
		serverDir = filepath.Dir(exe)
	}
	if root == "" {
		return Layout{}, errors.New("layout: no data root")
	}
	r, err := filepath.Abs(root)
	if err != nil {
		return Layout{}, err
	}
	s, err := filepath.Abs(serverDir)
	if err != nil {
		return Layout{}, err
	}
	return Layout{Root: r, ServerDir: s}, nil
}

// ── data root ────────────────────────────────────────────────────────────────

func (l Layout) ConfigDir() string   { return filepath.Join(l.Root, "config") }
func (l Layout) ConfigFile() string  { return filepath.Join(l.ConfigDir(), "config.json") }
func (l Layout) SecretsFile() string { return filepath.Join(l.ConfigDir(), "secrets.env") }
func (l Layout) ControlFile() string { return filepath.Join(l.ConfigDir(), "control.json") }
func (l Layout) AdminFile() string   { return filepath.Join(l.ConfigDir(), "admin-credentials.txt") }

func (l Layout) PGData() string    { return filepath.Join(l.Root, "pgdata") }
func (l Layout) NATSDir() string   { return filepath.Join(l.Root, "nats") }
func (l Layout) Storage() string   { return filepath.Join(l.Root, "storage") }
func (l Layout) Downloads() string { return filepath.Join(l.Root, "downloads") }
func (l Layout) TilesDir() string  { return filepath.Join(l.Root, "tiles") }
func (l Layout) GeocoderDir() string {
	return filepath.Join(l.Root, "geocoder")
}
func (l Layout) LogDir() string { return filepath.Join(l.Root, "logs") }
func (l Layout) RunDir() string { return filepath.Join(l.Root, "run") }

// RenderedDir holds the configs rendered from the payload's templates at every
// start (nats.conf, traefik). Regenerated, never edited by hand.
func (l Layout) RenderedDir() string { return filepath.Join(l.Root, "run", "config") }

// BinDir holds the third-party runtimes, fetched at install (online) or copied
// from the payload (offline). In the data root, like the NVR's, so the
// read-only program directory never has to be written after install.
func (l Layout) BinDir() string { return filepath.Join(l.Root, "bin") }

// DataDirs are created at provision, in this order.
func (l Layout) DataDirs() []string {
	return []string{
		l.ConfigDir(), l.NATSDir(), l.Storage(), l.Downloads(), l.TilesDir(),
		l.GeocoderDir(), l.LogDir(), l.RunDir(), l.RenderedDir(), l.BinDir(),
	}
}

// ── runtimes (under BinDir) ──────────────────────────────────────────────────

func (l Layout) PGBin() string         { return filepath.Join(l.BinDir(), "pgsql", "bin") }
func (l Layout) Postgres() string      { return filepath.Join(l.PGBin(), "postgres.exe") }
func (l Layout) InitDB() string        { return filepath.Join(l.PGBin(), "initdb.exe") }
func (l Layout) PGDump() string        { return filepath.Join(l.PGBin(), "pg_dump.exe") }
func (l Layout) PSQL() string          { return filepath.Join(l.PGBin(), "psql.exe") }
func (l Layout) NATSServer() string    { return filepath.Join(l.BinDir(), "nats", "nats-server.exe") }
func (l Layout) Traefik() string       { return filepath.Join(l.BinDir(), "traefik", "traefik.exe") }
func (l Layout) Node() string          { return filepath.Join(l.BinDir(), "node", "node.exe") }
func (l Layout) FFmpegBin() string     { return filepath.Join(l.BinDir(), "ffmpeg", "bin") }
func (l Layout) PopplerBin() string    { return filepath.Join(l.BinDir(), "poppler", "Library", "bin") }
func (l Layout) Java() string          { return filepath.Join(l.BinDir(), "jre", "bin", "java.exe") }
func (l Layout) PhotonJar() string     { return filepath.Join(l.BinDir(), "photon", "photon.jar") }
func (l Layout) PMTiles() string       { return filepath.Join(l.BinDir(), "pmtiles", "pmtiles.exe") }
func (l Layout) VendorReceipt() string { return filepath.Join(l.BinDir(), "vendorbin.lock.json") }

// ── payload (under ServerDir) ────────────────────────────────────────────────

func (l Layout) Python() string { return filepath.Join(l.ServerDir, "python", "python.exe") }

// ServiceDir is a Python service's source directory. Every service is a
// package called `app`, so they cannot share site-packages as installed
// packages; each runs with this as its working directory.
func (l Layout) ServiceDir(name string) string { return filepath.Join(l.ServerDir, "services", name) }

func (l Layout) WebServer(app string) string {
	return filepath.Join(l.ServerDir, "web", app, "server.js")
}
func (l Layout) TemplatesDir() string { return filepath.Join(l.ServerDir, "config") }
func (l Layout) Manifest() string     { return filepath.Join(l.ServerDir, "binaries.json") }

// Missing reports which of paths do not exist, for a clear startup error rather
// than a child that dies with "file not found" in its log.
func Missing(paths ...string) []string {
	var out []string
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			out = append(out, p)
		}
	}
	return out
}
