package mediamtx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return v
}

func TestFilterRanges(t *testing.T) {
	ranges := []PlaybackRange{
		{Start: "2026-07-09T10:00:00Z", Duration: 60}, // 10:00–10:01
		{Start: "2026-07-09T10:05:00Z", Duration: 60}, // 10:05–10:06
		{Start: "2026-07-09T11:00:00Z", Duration: 60}, // 11:00–11:01
	}

	// Window 10:00–10:10 overlaps the first two, not the 11:00 one.
	got := filterRanges(ranges, mustTime(t, "2026-07-09T10:00:00Z"), mustTime(t, "2026-07-09T10:10:00Z"))
	if len(got) != 2 {
		t.Fatalf("expected 2 overlapping ranges, got %d", len(got))
	}

	// A window fully inside a gap (10:02–10:04) overlaps nothing.
	got = filterRanges(ranges, mustTime(t, "2026-07-09T10:02:00Z"), mustTime(t, "2026-07-09T10:04:00Z"))
	if len(got) != 0 {
		t.Fatalf("expected 0 ranges in a gap window, got %d", len(got))
	}

	// Zero bounds disable filtering — everything comes back.
	got = filterRanges(ranges, time.Time{}, time.Time{})
	if len(got) != 3 {
		t.Fatalf("expected all 3 with no bounds, got %d", len(got))
	}

	// A boundary-touching window (ends exactly at a range start) does NOT overlap.
	got = filterRanges(ranges, mustTime(t, "2026-07-09T09:00:00Z"), mustTime(t, "2026-07-09T10:00:00Z"))
	if len(got) != 0 {
		t.Fatalf("expected 0 for a window ending at the first range start, got %d", len(got))
	}
}

func TestPlaybackURL(t *testing.T) {
	node := Node{PlaybackBase: "http://localhost/media/playback/"}
	got := PlaybackURL(node, "cameras/t/c/main", "2026-07-09T10:00:00Z", 90)

	if !strings.HasPrefix(got, "http://localhost/media/playback/get?") {
		t.Fatalf("unexpected prefix: %s", got)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := u.Query()
	if q.Get("path") != "cameras/t/c/main" {
		t.Fatalf("path = %q", q.Get("path"))
	}
	if q.Get("start") != "2026-07-09T10:00:00Z" {
		t.Fatalf("start = %q", q.Get("start"))
	}
	if q.Get("duration") != "90" {
		t.Fatalf("duration = %q", q.Get("duration"))
	}
	if q.Get("format") != "fmp4" {
		t.Fatalf("format = %q", q.Get("format"))
	}
}

func TestPlaybackList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/list" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("path") != "cameras/t/c/main" {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"start":"2026-07-09T10:00:00Z","duration":60},{"start":"2026-07-09T11:00:00Z","duration":30}]`))
	}))
	defer srv.Close()

	c := New()
	node := Node{ID: "n0", PlaybackAPIURL: srv.URL}

	// No filter → both ranges.
	got, err := c.PlaybackList(context.Background(), node, "cameras/t/c/main", time.Time{}, time.Time{})
	if err != nil {
		t.Fatalf("PlaybackList: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 ranges, got %d", len(got))
	}

	// Windowed → only the 10:00 range.
	got, err = c.PlaybackList(context.Background(), node, "cameras/t/c/main",
		mustTime(t, "2026-07-09T09:30:00Z"), mustTime(t, "2026-07-09T10:30:00Z"))
	if err != nil {
		t.Fatalf("PlaybackList windowed: %v", err)
	}
	if len(got) != 1 || got[0].Start != "2026-07-09T10:00:00Z" {
		t.Fatalf("expected only the 10:00 range, got %+v", got)
	}
}

func TestPlaybackListNoRecordings(t *testing.T) {
	// A 404 from the playback server (no recordings for the path) → empty, no error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := New()
	node := Node{ID: "n0", PlaybackAPIURL: srv.URL}
	got, err := c.PlaybackList(context.Background(), node, "cameras/t/c/main", time.Time{}, time.Time{})
	if err != nil {
		t.Fatalf("expected graceful empty on 404, got err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty ranges, got %d", len(got))
	}
}

func TestPlaybackListUnreachable(t *testing.T) {
	c := New()
	// A node with no playback API url → a clear error (caller maps to 502).
	if _, err := c.PlaybackList(context.Background(), Node{ID: "n0"}, "x", time.Time{}, time.Time{}); err == nil {
		t.Fatalf("expected error when PlaybackAPIURL is empty")
	}
}
