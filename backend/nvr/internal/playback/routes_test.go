package playback

import (
	"testing"
	"time"

	"github.com/neubit/nvr/internal/mediamtx"
)

func at(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return v
}

func TestWindowExplicit(t *testing.T) {
	from := at(t, "2026-07-09T10:00:00Z")
	to := at(t, "2026-07-09T10:05:00Z")
	start, dur, ok := window(from, to, nil)
	if !ok {
		t.Fatal("expected ok for an explicit window")
	}
	if dur != 300 {
		t.Fatalf("duration = %v, want 300", dur)
	}
	if start != "2026-07-09T10:00:00Z" {
		t.Fatalf("start = %q", start)
	}
}

func TestWindowSpansRanges(t *testing.T) {
	// No explicit window → span first range start to last range end.
	ranges := []mediamtx.PlaybackRange{
		{Start: "2026-07-09T10:00:00Z", Duration: 60},
		{Start: "2026-07-09T10:05:00Z", Duration: 30}, // ends 10:05:30
	}
	start, dur, ok := window(time.Time{}, time.Time{}, ranges)
	if !ok {
		t.Fatal("expected ok spanning ranges")
	}
	if start != "2026-07-09T10:00:00Z" {
		t.Fatalf("start = %q", start)
	}
	// 10:00:00 → 10:05:30 = 330s.
	if dur != 330 {
		t.Fatalf("duration = %v, want 330", dur)
	}
}

func TestWindowNoRecordingsNoWindow(t *testing.T) {
	if _, _, ok := window(time.Time{}, time.Time{}, nil); ok {
		t.Fatal("expected not-ok with no window and no recordings")
	}
}

func TestParseTimeOptional(t *testing.T) {
	tm, err := parseTime("")
	if err != nil || !tm.IsZero() {
		t.Fatalf("empty should be zero-time, no error; got %v, %v", tm, err)
	}
	if _, err := parseTime("not-a-time"); err == nil {
		t.Fatal("expected error for bad time")
	}
}
