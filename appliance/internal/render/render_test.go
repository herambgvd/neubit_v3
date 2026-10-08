package render

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/neubit/vms-appliance/internal/layout"
)

// The repo's own files are the templates; these tests render THEM, so a route
// or a bus user added for Docker that the appliance cannot serve fails here.
const repo = "../../.."

func TestEveryRepoRouteRendersToLoopback(t *testing.T) {
	out := t.TempDir()
	static, err := Gateway(filepath.Join(repo, "gateway"), out, layout.DefaultPorts(), "")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(static)
	if !strings.Contains(string(b), `address: ":80"`) || !strings.Contains(string(b), "dashboard: false") {
		t.Fatalf("static config:\n%s", b)
	}
	routes, err := os.ReadFile(filepath.Join(out, "dynamic", "routes.yml"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(routes)
	for _, want := range []string{"http://127.0.0.1:18000", "http://127.0.0.1:18004", "http://127.0.0.1:13000"} {
		if !strings.Contains(s, want) {
			t.Errorf("routes missing %s", want)
		}
	}
	if m := regexp.MustCompile(`http://(core|vision|frontend|ingest|workflow|access|reading-writer|tiles|geocoder):`).FindString(s); m != "" {
		t.Fatalf("a container address survived: %s", m)
	}
	mw, _ := os.ReadFile(filepath.Join(out, "dynamic", "middlewares.yml"))
	if !strings.Contains(string(mw), "http://127.0.0.1:18000/internal/auth/verify") {
		t.Fatal("forward-auth not pointed at native core")
	}
}

func TestAnUnknownUpstreamFailsTheRender(t *testing.T) {
	_, err := RewriteUpstreams(`url: "http://newservice:8000"`, NativeUpstreams(layout.DefaultPorts(), ""))
	if err == nil || !strings.Contains(err.Error(), "newservice:8000") {
		t.Fatalf("err %v", err)
	}
}

func TestNVRRoutesFollowTheConfiguredRecorder(t *testing.T) {
	u := NativeUpstreams(layout.DefaultPorts(), "http://10.0.0.5:8000/")
	if u["nvr:8000"] != "http://10.0.0.5:8000" || u["mediamtx:8889"] != "http://10.0.0.5:8889" {
		t.Fatalf("%v", u)
	}
}

func TestNATSKeepsEveryUserAndMovesTheStore(t *testing.T) {
	tpl, err := os.ReadFile(filepath.Join(repo, "deploy", "nats", "nats.conf"))
	if err != nil {
		t.Fatal(err)
	}
	out, err := NATS(string(tpl), `C:\ProgramData\Neubit\VMS\nats`, layout.DefaultPorts())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `store_dir: "C:/ProgramData/Neubit/VMS/nats"`) {
		t.Fatal("store not relocated")
	}
	if !strings.Contains(out, `listen: "127.0.0.1:14222"`) || !strings.Contains(out, `http: "127.0.0.1:18222"`) {
		t.Fatal("not loopback")
	}
	for _, u := range []string{"core", "access", "ingest", "vision", "workflow", "reading-writer", "conflux-edge"} {
		if !strings.Contains(out, `user: "`+u+`"`) {
			t.Errorf("bus user %s lost", u)
		}
	}
	if strings.Count(out, "$NATS_PASS_") != strings.Count(string(tpl), "$NATS_PASS_") {
		t.Fatal("a password reference changed")
	}
}
