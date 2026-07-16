package sqlitestore

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// SQLite has no native time or json types — timestamps are stored as RFC3339
// UTC TEXT (string-comparable for the range scans playback needs) and JSON
// columns as TEXT documents. These helpers centralise the conversions so every
// repo marshals identically.

// rfc renders a time as RFC3339 UTC TEXT.
func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// nowUTC is the store's clock (second precision matches the RFC3339 TEXT format).
func nowUTC() time.Time { return time.Now().UTC() }

// b2i maps a bool to SQLite's INTEGER 0/1 boolean representation.
func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// nullRFC renders a nullable timestamp as a query arg (nil → SQL NULL).
func nullRFC(t *time.Time) any {
	if t == nil {
		return nil
	}
	return rfc(*t)
}

// scanTime converts a nullable RFC3339 TEXT column back to *time.Time.
func scanTime(ns sql.NullString) *time.Time {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	tt, err := time.Parse(time.RFC3339, ns.String)
	if err != nil {
		return nil
	}
	return &tt
}

// mustTime converts a NOT NULL RFC3339 TEXT column to time.Time (zero on parse error).
func mustTime(s string) time.Time {
	tt, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return tt
}

// strPtr converts a nullable TEXT column to *string.
func strPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	s := ns.String
	return &s
}

// intPtr converts a nullable INTEGER column to *int.
func intPtr(ni sql.NullInt64) *int {
	if !ni.Valid {
		return nil
	}
	v := int(ni.Int64)
	return &v
}

// placeholders returns "?,?,…" with n marks, for a positional INSERT.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

// jsonText renders a JSON column for storage; nil/empty falls back to def
// (matching the schema's DEFAULT '{}' / '[]').
func jsonText(v json.RawMessage, def string) string {
	if len(v) == 0 {
		return def
	}
	return string(v)
}

// scanJSON converts a JSON TEXT column back to json.RawMessage.
func scanJSON(ns sql.NullString) json.RawMessage {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	return json.RawMessage(ns.String)
}
