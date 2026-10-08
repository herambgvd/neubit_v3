package tiles

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func serve(t *testing.T) http.Handler {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "planet.pmtiles"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	return Handler(dir)
}

func get(h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRangeReadsLikeNginx(t *testing.T) {
	rec := get(serve(t), "/tiles/planet.pmtiles", map[string]string{"Range": "bytes=2-4"})
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "234" {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=86400" || rec.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("headers %v", rec.Header())
	}
}

func TestNoTraversalNoListingNoDotfiles(t *testing.T) {
	h := serve(t)
	for _, p := range []string{"/tiles/", "/tiles/../secrets.env", "/tiles/..%5Csecrets.env", "/tiles/.hidden", "/tiles/a/b"} {
		// 404, or the mux's own redirect to the cleaned path: never content.
		if rec := get(h, p, nil); rec.Code != http.StatusNotFound && rec.Code != http.StatusTemporaryRedirect {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
}

func TestHealth(t *testing.T) {
	if rec := get(serve(t), "/tiles-health", nil); rec.Code != 200 || rec.Body.String() != "ok\n" {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
}
