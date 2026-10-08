// Package secrets owns secrets.env: every credential the appliance's processes
// share, generated once per machine with a CSPRNG and never regenerated.
//
// Never regenerated is the load-bearing part. Postgres holds a cluster created
// under POSTGRES_PASSWORD, NATS checks each service's NATS_PASS_*, and every
// session token was signed with VE_JWT_SECRET; minting a new value on a re-run
// locks the stack out of its own data. So Ensure only ever ADDS missing keys —
// the same rule as Route B's add_kv_if_missing.
package secrets

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"sort"
	"strings"

	"github.com/neubit/vms-appliance/internal/layout"
)

// NATSUsers are the bus identities in deploy/nats/nats.conf. The bus has no
// anonymous fallback, so each needs a password.
var NATSUsers = []string{"CORE", "ACCESS", "INGEST", "VISION", "WORKFLOW", "READING_WRITER", "CONFLUX"}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// Random returns n characters from [A-Za-z0-9], uniformly.
func Random(n int) (string, error) {
	var b strings.Builder
	max := big.NewInt(int64(len(alphabet)))
	for i := 0; i < n; i++ {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(alphabet[v.Int64()])
	}
	return b.String(), nil
}

// Secrets is the parsed file, plus the keys a run added.
type Secrets struct {
	Values map[string]string
	Added  []string
}

func (s Secrets) Get(k string) string { return s.Values[k] }

// generators: key -> how to mint it. Order matters only for the file layout.
func generators() []struct {
	key string
	gen func() (string, error)
} {
	r := func(n int) func() (string, error) { return func() (string, error) { return Random(n) } }
	g := []struct {
		key string
		gen func() (string, error)
	}{
		{"POSTGRES_USER", func() (string, error) { return "neubit", nil }},
		{"POSTGRES_PASSWORD", r(32)},
		{"VE_JWT_SECRET", r(48)},
		{"VE_SECRETS_KEY", r(48)},
		{"OPS_AGENT_TOKEN", r(32)},
	}
	for _, u := range NATSUsers {
		g = append(g, struct {
			key string
			gen func() (string, error)
		}{"NATS_PASS_" + u, r(32)})
	}
	return g
}

// Ensure loads secrets.env and adds any key that is missing. Existing values are
// never touched.
func Ensure(l layout.Layout) (Secrets, error) {
	s, err := Load(l.SecretsFile())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Secrets{}, err
	}
	if s.Values == nil {
		s.Values = map[string]string{}
	}
	for _, g := range generators() {
		if s.Values[g.key] != "" {
			continue
		}
		v, err := g.gen()
		if err != nil {
			return Secrets{}, fmt.Errorf("generating %s: %w", g.key, err)
		}
		s.Values[g.key] = v
		s.Added = append(s.Added, g.key)
	}
	if len(s.Added) > 0 {
		if err := Save(l.SecretsFile(), s.Values); err != nil {
			return Secrets{}, err
		}
	}
	return s, nil
}

// Set writes one key (bootstrap admin, licence) and saves.
func Set(l layout.Layout, key, value string) error {
	s, err := Load(l.SecretsFile())
	if err != nil {
		return err
	}
	s.Values[key] = value
	return Save(l.SecretsFile(), s.Values)
}

// Load parses KEY=VALUE lines; blank lines and # comments are ignored.
func Load(path string) (Secrets, error) {
	f, err := os.Open(path)
	if err != nil {
		return Secrets{Values: map[string]string{}}, err
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return Secrets{Values: out}, sc.Err()
}

// Save writes the file atomically, keys sorted, with a header saying what it is.
func Save(path string, values map[string]string) error {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b bytes.Buffer
	b.WriteString("# Neubit VMS appliance secrets - generated on this machine, unique to it.\n")
	b.WriteString("# Kept across upgrades: Postgres, NATS and every session depend on these\n")
	b.WriteString("# exact values. Do not edit; do not copy to another machine.\n")
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%s\n", k, values[k])
	}
	return layout.WriteFileAtomic(path, b.Bytes(), 0o600)
}

// Masked renders the file for a log or a support bundle.
func Masked(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		v := values[k]
		if k != "POSTGRES_USER" && k != "VE_BOOTSTRAP_ADMIN_EMAIL" {
			v = "********"
		}
		fmt.Fprintf(&b, "%s=%s\n", k, v)
	}
	return b.String()
}
