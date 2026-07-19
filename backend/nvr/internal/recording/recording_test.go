package recording

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParsePath(t *testing.T) {
	dir := "/recordings"
	p := "/recordings/cameras/tenantA/cam-1/main/2026-07-09_10-00-00-000000.mp4"
	tenant, cam, profile, ok := parsePath(p, dir)
	if !ok {
		t.Fatalf("expected parse ok for %q", p)
	}
	if tenant != "tenantA" || cam != "cam-1" || profile != "main" {
		t.Fatalf("got tenant=%q cam=%q profile=%q", tenant, cam, profile)
	}

	// Trailing-slash dir is handled the same.
	if _, _, _, ok := parsePath(p, "/recordings/"); !ok {
		t.Fatalf("expected parse ok with trailing-slash dir")
	}

	// A path that does not match the cameras/<t>/<c>/<p>/<seg> layout → not ok.
	if _, _, _, ok := parsePath("/recordings/junk/file.mp4", dir); ok {
		t.Fatalf("expected parse to reject a non-conforming path")
	}
}

func TestParseSegmentStart(t *testing.T) {
	want := time.Date(2026, 7, 9, 10, 30, 15, 123456000, time.UTC)
	// Legacy flat filename (full stamp in the name).
	if got := parseSegmentStart("2026-07-09_10-30-15-123456.mp4"); !got.Equal(want) {
		t.Fatalf("flat parse: got %v want %v", got, want)
	}
	// Day-foldered path: date from the parent dir, time from the filename.
	if got := parseSegmentStart("/pools/1/cameras/t/c/main/2026-07-09/10-30-15-123456.mp4"); !got.Equal(want) {
		t.Fatalf("day-folder parse: got %v want %v", got, want)
	}
	// Second-precision (no micros) day-foldered path.
	wantSec := time.Date(2026, 7, 9, 10, 30, 15, 0, time.UTC)
	if got := parseSegmentStart("/x/main/2026-07-09/10-30-15.mp4"); !got.Equal(wantSec) {
		t.Fatalf("day-folder sec parse: got %v want %v", got, wantSec)
	}
	// A non-conforming name → zero time (emit falls back to mtime).
	if !parseSegmentStart("garbage.mp4").IsZero() {
		t.Fatalf("expected zero time for a non-conforming segment name")
	}
}

func TestRecordPathTemplate(t *testing.T) {
	if got := recordPathTemplate("/recordings"); got != "/recordings/%path/%Y-%m-%d/%H-%M-%S-%f" {
		t.Fatalf("record template: %q", got)
	}
	// Trailing slash normalised.
	if got := recordPathTemplate("/recordings/"); got != "/recordings/%path/%Y-%m-%d/%H-%M-%S-%f" {
		t.Fatalf("record template (trailing slash): %q", got)
	}
}

func TestCollectSegments(t *testing.T) {
	root := t.TempDir()
	pathDir := filepath.Join(root, "cameras", "t1", "c1", "main")
	if err := os.MkdirAll(pathDir, 0o755); err != nil {
		t.Fatal(err)
	}
	seg := filepath.Join(pathDir, "2026-07-09_10-00-00-000000.mp4")
	if err := os.WriteFile(seg, []byte("fmp4data"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A non-mp4 sibling must be ignored.
	if err := os.WriteFile(filepath.Join(pathDir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Supervisor{dirMtime: map[string]time.Time{}, scanMark: map[string]string{}}
	segs, err := s.collectSegments(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 1 {
		t.Fatalf("expected 1 segment, got %d", len(segs))
	}
	if segs[0].size != int64(len("fmp4data")) {
		t.Fatalf("segment size: got %d", segs[0].size)
	}
	if segs[0].start.IsZero() {
		t.Fatalf("segment start should parse from the filename")
	}

	// Incremental: once the dir's watermark covers the file, a re-scan skips it.
	s.scanMark[pathDir] = "2026-07-09_10-00-00-000000.mp4"
	if again, _ := s.collectSegments(root); len(again) != 0 {
		t.Fatalf("watermark should skip an already-emitted segment, got %d", len(again))
	}

	// A missing root is a graceful error (no recordings yet), not a panic.
	if _, err := s.collectSegments(filepath.Join(root, "nope")); err == nil {
		t.Fatalf("expected error for a missing recordings root")
	}
}

func TestIsDayFolder(t *testing.T) {
	for name, want := range map[string]bool{
		"2026-07-19": true, "2026-12-01": true,
		"main": false, "cameras": false, "2026-7-9": false, "2026-07-1x": false, "": false,
	} {
		if got := isDayFolder(name); got != want {
			t.Errorf("isDayFolder(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestStaleDayFolder(t *testing.T) {
	cutoff := "2026-07-17" // keep 07-17 and newer; prune older
	cases := map[string]bool{
		"2026-07-15":     true,  // older → stale
		"2026-07-16":     true,  // older → stale
		"2026-07-17":     false, // == cutoff → kept
		"2026-07-18":     false, // newer → kept
		"main":           false, // non-date dir → never stale (must descend)
		"cameras":        false,
		"2026-7-8":       false, // wrong shape → not a day-folder
		"2026-07-1x":     false, // non-numeric → not a day-folder
	}
	for name, want := range cases {
		if got := staleDayFolder(name, cutoff); got != want {
			t.Errorf("staleDayFolder(%q, %q) = %v, want %v", name, cutoff, got, want)
		}
	}
	// cutoff is 2 days back (UTC) → today's folder is always kept.
	today := time.Now().UTC().Format("2006-01-02")
	if staleDayFolder(today, dayFolderCutoff(time.Now())) {
		t.Errorf("today's day-folder %q must never be pruned", today)
	}
}
