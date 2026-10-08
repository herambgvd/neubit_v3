package layout

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is config.json: the operator's choices, persisted across upgrades.
// Secrets are NOT here (secrets.env, its own ACL) so this file can be read in a
// support session without handing over the keys.
type Config struct {
	// Ports overrides on top of DefaultPorts, as typed: "ui=8090,core=18010".
	PortOverrides string `json:"port_overrides,omitempty"`

	// RuntimeEnv is VE_ENV for the stack: "dev" or "prod". Core refuses prod
	// without a signed licence, so the installer defaults to dev until one is
	// supplied — the same rule as deploy/windows/install-appliance.ps1.
	RuntimeEnv string `json:"runtime_env"`

	// AdvertiseHost is the name or address LAN clients use, shown by the shell
	// and the installer. Empty: the machine's own name.
	AdvertiseHost string `json:"advertise_host,omitempty"`

	// GeocoderCountry and TilesMaxZoom drive background provisioning of the map
	// data (see the tiles and geocoder sections of the design doc).
	GeocoderCountry string `json:"geocoder_country"`
	TilesMaxZoom    int    `json:"tiles_maxzoom"`
	// MapAutoProvision lets the service download tiles/geocoder data itself. Off
	// on air-gapped sites, where the operator copies the files in.
	MapAutoProvision bool `json:"map_auto_provision"`

	// NVRURL points vision at a Neubit NVR on the same machine, if any
	// (http://127.0.0.1:8000). Federation with remote recorders needs nothing here.
	NVRURL string `json:"nvr_url,omitempty"`
	// RecordingsDir is that NVR's footage root, read by vision for checksums.
	RecordingsDir string `json:"recordings_dir,omitempty"`
}

// DefaultConfig is what a first install writes.
func DefaultConfig() Config {
	return Config{
		RuntimeEnv:       "dev",
		GeocoderCountry:  "in",
		TilesMaxZoom:     10,
		MapAutoProvision: true,
	}
}

// Ports resolves the effective port plan.
func (c Config) Ports() (Ports, error) {
	p := DefaultPorts()
	if err := p.ApplyOverrides(c.PortOverrides); err != nil {
		return Ports{}, err
	}
	return p, nil
}

// Validate checks the values an operator can get wrong.
func (c Config) Validate() error {
	switch c.RuntimeEnv {
	case "dev", "prod":
	default:
		return fmt.Errorf("runtime_env %q: want dev or prod", c.RuntimeEnv)
	}
	if c.TilesMaxZoom < 0 || c.TilesMaxZoom > 15 {
		return fmt.Errorf("tiles_maxzoom %d: want 0..15", c.TilesMaxZoom)
	}
	if strings.TrimSpace(c.GeocoderCountry) == "" {
		return errors.New("geocoder_country is empty")
	}
	_, err := c.Ports()
	return err
}

// LoadConfig reads config.json, returning the defaults when there is none yet.
// Fields missing from an older file keep their defaults.
func LoadConfig(path string) (Config, error) {
	c := DefaultConfig()
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return Config{}, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	return c, c.Validate()
}

// SaveConfig writes config.json atomically (temp file + rename), so a crash
// mid-write never leaves an unparseable file that stops the service starting.
func SaveConfig(path string, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, append(b, '\n'), 0o600)
}

// WriteFileAtomic writes via a sibling temp file and a rename.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, perm); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}
