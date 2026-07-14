package httpx

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/neubit/gokernel/config"
)

// NewRouter builds a chi router with the base middleware stack applied globally
// (request-id → recover → CORS). JWT auth is NOT global — mount it per group via
// RequireAuth so /health stays public, matching the Python services.
func NewRouter(s *config.Settings) *chi.Mux {
	r := chi.NewRouter()
	r.Use(RequestID)
	r.Use(Recover)
	r.Use(CORS(s))
	return r
}

// Health registers GET /health returning {"status":"ok","service":..,"env":..},
// matching the Python services' health handler shape.
func Health(r chi.Router, service, env string) {
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		JSON(w, http.StatusOK, map[string]any{
			"status":  "ok",
			"service": service,
			"env":     env,
		})
	})
}

// JSON writes v as a JSON response with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
