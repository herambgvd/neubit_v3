// Package webui serves the box-served node console — a standalone static SPA
// (Vite/React) built into dist/ and embedded into the nvr binary. It is mounted at
// the site root ONLY in autonomous-node mode (NVR_STORE=sqlite); the SPA talks to
// the same origin's /api/v1/nvr/estate/* API, so the appliance ships one binary
// that serves both the API and the operator UI with no external web server.
//
// The dist/ directory is committed to the repo (NOT gitignored) so `go build` always
// has a working UI to embed — rebuild it with `npm run build` in this directory.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// FS is the embedded built UI rooted at dist/ (so "index.html" resolves directly).
// Exposed for callers that want to serve or inspect the assets themselves.
var FS = mustSub(distFS, "dist")

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		// The go:embed above guarantees dist/ exists at build time; a failure here
		// is a programming error, not a runtime condition.
		panic("webui: cannot sub into " + dir + ": " + err.Error())
	}
	return sub
}

// Handler serves the embedded SPA with a history-fallback: a request for an existing
// asset (has a file extension and the file exists) is served from dist/; any other
// path — a client-side route like /dashboard or /login — falls back to index.html so
// react-router can render it. This lets the single-page app own its own routing while
// the Go server owns /api/* and /health (registered before this catch-all).
func Handler() http.Handler {
	fileServer := http.FileServer(http.FS(FS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if reqPath == "" {
			serveIndex(w, r)
			return
		}
		// If the requested path maps to an embedded file, serve it directly.
		if f, err := FS.Open(reqPath); err == nil {
			if info, statErr := f.Stat(); statErr == nil && !info.IsDir() {
				_ = f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
			_ = f.Close()
		}
		// Otherwise this is a client-side route — hand back the SPA entrypoint.
		serveIndex(w, r)
	})
}

// serveIndex writes index.html (the SPA shell) with a no-cache header so a newly
// built binary always ships fresh HTML that references the current hashed assets.
func serveIndex(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(FS, "index.html")
	if err != nil {
		http.Error(w, "web UI not built", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}
