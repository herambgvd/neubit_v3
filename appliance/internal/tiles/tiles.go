// Package tiles serves the basemap file(s) the way deploy/tiles-server/nginx.conf
// does for the Docker stack: /tiles/<file> from one directory, HTTP Range
// (a PMTiles client reads the archive in byte ranges), a day of caching, no
// directory listing, no gzip, and /tiles-health.
//
// It runs as its own supervised process (`neubitvms-svc serve-tiles`), so a
// stalled read can never hold up the supervisor.
package tiles

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Handler serves dir under /tiles/.
func Handler(dir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/tiles-health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, "ok\n")
	})
	mux.HandleFunc("/tiles/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(r.URL.Path, "/tiles/")), "/")
		// No listing, no subdirectories, no dot-files, nothing outside dir.
		if name == "" || name == "." || strings.ContainsAny(name, `/\:`) || strings.HasPrefix(name, ".") {
			http.NotFound(w, r)
			return
		}
		p := filepath.Join(dir, name)
		f, err := os.Open(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Accept-Ranges", "bytes")
		if strings.HasSuffix(name, ".pmtiles") {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		http.ServeContent(w, r, name, st.ModTime(), f)
	})
	return mux
}

// Serve listens on 127.0.0.1:port until the process is stopped.
func Serve(dir string, port int) error {
	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", port),
		Handler:           Handler(dir),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv.ListenAndServe()
}
