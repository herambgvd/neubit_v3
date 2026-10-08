package layout

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Ports is every TCP port the appliance uses. Only UI is reachable from the LAN;
// everything else binds 127.0.0.1.
//
// The internal block (13xxx/18xxx/14xxx/15xxx) is chosen so a Neubit NVR can be
// installed on the same server: the NVR takes 8000 (API), 8080 (console), 5432
// (Postgres), 8079 (control), 8554/8888/8889/9996/9997 and 8189 (MediaMTX).
type Ports struct {
	UI            int `json:"ui"`
	Control       int `json:"control"`
	Postgres      int `json:"postgres"`
	NATS          int `json:"nats"`
	NATSMonitor   int `json:"nats_monitor"`
	Core          int `json:"core"`
	Ingest        int `json:"ingest"`
	Workflow      int `json:"workflow"`
	Access        int `json:"access"`
	Vision        int `json:"vision"`
	ReadingWriter int `json:"reading_writer"`
	Frontend      int `json:"frontend"`
	Admin         int `json:"admin"`
	Tiles         int `json:"tiles"`
	Geocoder      int `json:"geocoder"`
}

// DefaultPorts is the plan documented in docs/WINDOWS_NATIVE_APPLIANCE.md §2.
func DefaultPorts() Ports {
	return Ports{
		UI:            80,
		Control:       18079,
		Postgres:      15432,
		NATS:          14222,
		NATSMonitor:   18222,
		Core:          18000,
		Ingest:        18001,
		Workflow:      18002,
		Access:        18003,
		Vision:        18004,
		ReadingWriter: 18005,
		Frontend:      13000,
		Admin:         13001,
		Tiles:         18080,
		Geocoder:      12322,
	}
}

// fields maps the names an operator types in -Ports to the struct fields.
func (p *Ports) fields() map[string]*int {
	return map[string]*int{
		"ui":             &p.UI,
		"control":        &p.Control,
		"postgres":       &p.Postgres,
		"nats":           &p.NATS,
		"nats_monitor":   &p.NATSMonitor,
		"core":           &p.Core,
		"ingest":         &p.Ingest,
		"workflow":       &p.Workflow,
		"access":         &p.Access,
		"vision":         &p.Vision,
		"reading_writer": &p.ReadingWriter,
		"frontend":       &p.Frontend,
		"admin":          &p.Admin,
		"tiles":          &p.Tiles,
		"geocoder":       &p.Geocoder,
	}
}

// Names lists the port names in a stable order, for messages and `ports`.
func (p Ports) Names() []string {
	m := p.fields()
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Get returns a port by name.
func (p Ports) Get(name string) (int, bool) {
	v, ok := p.fields()[name]
	if !ok {
		return 0, false
	}
	return *v, true
}

// ApplyOverrides parses "ui=8090,core=18010" onto p. An unknown name or a
// non-port value is an error naming it: a typo must not silently keep the
// default and then collide with whatever the operator was avoiding.
func (p *Ports) ApplyOverrides(spec string) error {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil
	}
	fields := p.fields()
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			return fmt.Errorf("port override %q: want name=port", part)
		}
		k = strings.ToLower(strings.TrimSpace(k))
		ptr, known := fields[k]
		if !known {
			return fmt.Errorf("port override %q: unknown port %q (known: %s)", part, k, strings.Join(p.Names(), ", "))
		}
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("port override %q: %q is not a TCP port", part, v)
		}
		*ptr = n
	}
	return p.Validate()
}

// Validate rejects a plan in which two things would bind the same port.
func (p Ports) Validate() error {
	seen := map[int]string{}
	for _, name := range p.Names() {
		v, _ := p.Get(name)
		if v < 1 || v > 65535 {
			return fmt.Errorf("port %s=%d is not a TCP port", name, v)
		}
		if other, dup := seen[v]; dup {
			return fmt.Errorf("ports %s and %s are both %d", other, name, v)
		}
		seen[v] = name
	}
	return nil
}
