package secrets

import (
	"os"
	"strings"
	"testing"

	"github.com/neubit/vms-appliance/internal/layout"
)

func TestEnsureGeneratesOnceAndNeverRotates(t *testing.T) {
	l, _ := layout.New(t.TempDir(), t.TempDir())
	first, err := Ensure(l)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Values["POSTGRES_PASSWORD"]) != 32 || first.Values["NATS_PASS_VISION"] == "" {
		t.Fatalf("%v", first.Values)
	}
	second, err := Ensure(l)
	if err != nil {
		t.Fatal(err)
	}
	// Rotating these would lock the stack out of its own database and bus.
	for k, v := range first.Values {
		if second.Values[k] != v {
			t.Fatalf("%s changed on a re-run", k)
		}
	}
	if len(second.Added) != 0 {
		t.Fatalf("re-run added %v", second.Added)
	}
}

func TestEnsureAddsOnlyWhatIsMissing(t *testing.T) {
	l, _ := layout.New(t.TempDir(), t.TempDir())
	_ = os.MkdirAll(l.ConfigDir(), 0o755)
	_ = Save(l.SecretsFile(), map[string]string{"POSTGRES_PASSWORD": "kept"})
	s, err := Ensure(l)
	if err != nil {
		t.Fatal(err)
	}
	if s.Values["POSTGRES_PASSWORD"] != "kept" {
		t.Fatal("an existing secret was replaced")
	}
	if !strings.Contains(strings.Join(s.Added, ","), "NATS_PASS_CORE") {
		t.Fatalf("added %v", s.Added)
	}
}

func TestMaskedHidesEverySecret(t *testing.T) {
	out := Masked(map[string]string{"POSTGRES_USER": "neubit", "POSTGRES_PASSWORD": "pw", "VE_JWT_SECRET": "j"})
	if strings.Contains(out, "=pw") || strings.Contains(out, "=j\n") || !strings.Contains(out, "POSTGRES_USER=neubit") {
		t.Fatal(out)
	}
}

func TestRandomUsesTheAlphabet(t *testing.T) {
	v, _ := Random(64)
	if len(v) != 64 || strings.Trim(v, alphabet) != "" {
		t.Fatal(v)
	}
}
