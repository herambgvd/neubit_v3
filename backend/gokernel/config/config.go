// Package config loads shared neubit_v3 settings from the environment.
//
// It mirrors the Python kernel's `kernel.config.Settings` (backend/kernel):
// the SAME `VE_` env prefix and the SAME field names, so a Go service reads the
// exact env vars the Python core/services do — the JWT secret, the NATS URL and
// the per-service database URL stay compatible across languages without
// duplicating config conventions.
package config

import (
	"os"
	"strconv"
	"strings"
)

// Settings is the shared configuration for a Go service. Every field maps to a
// `VE_*` env var (see envKey), matching the Python kernel one-for-one.
type Settings struct {
	// Env is the deployment environment name ("dev", "prod", ...). VE_ENV.
	Env string
	// AppName is the service name (also used as the NATS event `source`). VE_APP_NAME.
	AppName string
	// APIPrefix is the mount prefix for versioned routes. VE_API_PREFIX.
	APIPrefix string
	// Port is the HTTP listen port. VE_PORT.
	Port int

	// DatabaseURL is this service's OWN Postgres DSN. VE_DATABASE_URL.
	//
	// The Python services use a SQLAlchemy/asyncpg URL
	// (postgresql+asyncpg://...). pgx wants a plain libpq DSN, so NormalizedDSN()
	// strips the +asyncpg / +psycopg driver suffix. Store the raw value here.
	DatabaseURL string
	// NATSURL is the event spine. Empty → events are no-ops (standalone). VE_NATS_URL.
	NATSURL string

	// JWTSecret verifies the core-minted access token. MUST equal the secret the
	// Python core signs with (HS256). VE_JWT_SECRET.
	JWTSecret string

	// CORSOrigins is the allowed browser origin list. VE_CORS_ORIGINS (JSON array
	// or comma-separated).
	CORSOrigins []string
	// CORSOriginRegex echoes any matching origin. VE_CORS_ORIGIN_REGEX.
	CORSOriginRegex string
}

// Load reads the environment once and returns the resolved Settings. Defaults
// match the Python kernel so a shared .env "just works".
func Load() *Settings {
	return &Settings{
		Env:             env("VE_ENV", "dev"),
		AppName:         env("VE_APP_NAME", "neubit-service"),
		APIPrefix:       env("VE_API_PREFIX", "/api/v1"),
		Port:            envInt("VE_PORT", 8000),
		DatabaseURL:     env("VE_DATABASE_URL", "postgresql://neubit:neubit@localhost:5432/neubit"),
		NATSURL:         env("VE_NATS_URL", ""),
		JWTSecret:       env("VE_JWT_SECRET", "change-me-in-prod"),
		CORSOrigins:     envList("VE_CORS_ORIGINS", []string{"http://localhost:3000"}),
		CORSOriginRegex: env("VE_CORS_ORIGIN_REGEX", `https?://.*`),
	}
}

// NormalizedDSN returns a libpq/pgx-compatible DSN. The Python services store
// SQLAlchemy URLs (postgresql+asyncpg://, postgresql+psycopg://); pgx cannot
// parse the "+driver" suffix, so we drop it here. Plain postgres:// URLs pass
// through unchanged.
func (s *Settings) NormalizedDSN() string {
	dsn := s.DatabaseURL
	for _, p := range []string{"+asyncpg", "+psycopg", "+psycopg2", "+pg8000"} {
		dsn = strings.Replace(dsn, p, "", 1)
	}
	return dsn
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// envList parses a JSON array (["a","b"]) or a comma-separated string.
func envList(key string, def []string) []string {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, "[") {
		// Minimal JSON-array parse: strip brackets/quotes, split on comma.
		inner := strings.TrimSuffix(strings.TrimPrefix(v, "["), "]")
		var out []string
		for _, part := range strings.Split(inner, ",") {
			part = strings.TrimSpace(part)
			part = strings.Trim(part, `"'`)
			if part != "" {
				out = append(out, part)
			}
		}
		if len(out) > 0 {
			return out
		}
		return def
	}
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}
