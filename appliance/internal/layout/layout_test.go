package layout

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultPortsDoNotCollideWithEachOtherOrACoInstalledNVR(t *testing.T) {
	p := DefaultPorts()
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	// The NVR's fixed ports (neubit_nvr layout.go).
	nvr := map[int]bool{8000: true, 8080: true, 5432: true, 8079: true, 8554: true, 8888: true, 8889: true, 9996: true, 9997: true, 8189: true, 3001: true}
	for _, n := range p.Names() {
		v, _ := p.Get(n)
		if nvr[v] {
			t.Errorf("%s=%d is an NVR port", n, v)
		}
	}
}

func TestOverridesAreValidatedAndNamed(t *testing.T) {
	p := DefaultPorts()
	if err := p.ApplyOverrides("ui=8090, core=18010"); err != nil || p.UI != 8090 || p.Core != 18010 {
		t.Fatalf("%v %+v", err, p)
	}
	for _, bad := range []string{"uii=1", "ui=70000", "ui", "ui=18000"} {
		q := DefaultPorts()
		if err := q.ApplyOverrides(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestConfigRoundTripsAndKeepsDefaultsForNewFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	c := DefaultConfig()
	c.PortOverrides = "ui=8090"
	if err := SaveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfig(path)
	if err != nil || got.PortOverrides != "ui=8090" || got.TilesMaxZoom != 10 {
		t.Fatalf("%v %+v", err, got)
	}
	c.RuntimeEnv = "staging"
	if err := SaveConfig(path, c); err == nil || !strings.Contains(err.Error(), "runtime_env") {
		t.Fatalf("invalid env saved: %v", err)
	}
}

func TestMissingConfigIsTheDefault(t *testing.T) {
	c, err := LoadConfig(filepath.Join(t.TempDir(), "none.json"))
	if err != nil || c.RuntimeEnv != "dev" {
		t.Fatalf("%v %+v", err, c)
	}
}
