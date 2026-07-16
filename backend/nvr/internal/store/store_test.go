package store

import (
	"encoding/json"
	"testing"
	"time"
)

// TestStoreInterfaceShape asserts the seam type + core structs exist and compile.
func TestStoreInterfaceShape(t *testing.T) {
	var s Store // nil is fine; we assert the type exists + method set compiles
	_ = s

	c := Camera{ID: "x", Name: "cam"}
	if c.ID != "x" {
		t.Fatalf("Camera struct broken")
	}
}

// TestJSONColumnsMarshal ensures the JSON-column fields round-trip cleanly (they
// carry documents in both backends; a nil RawMessage must not break marshalling).
func TestJSONColumnsMarshal(t *testing.T) {
	seg := RecordingSegment{
		Path:         "/rec/a.mp4",
		TenantID:     "t1",
		CameraID:     "c1",
		Profile:      "main",
		EventMarkers: json.RawMessage(`[]`),
	}
	b, err := json.Marshal(seg)
	if err != nil {
		t.Fatalf("marshal segment: %v", err)
	}
	var back RecordingSegment
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal segment: %v", err)
	}
	if back.Path != seg.Path || back.CameraID != "c1" {
		t.Fatalf("round-trip mismatch: %+v", back)
	}
}

// TestNullableTimestamps confirms *time.Time nullable columns behave.
func TestNullableTimestamps(t *testing.T) {
	now := time.Now().UTC()
	cam := Camera{ID: "c1", Name: "Ch1", LastSeenAt: &now}
	if cam.LastSeenAt == nil || !cam.LastSeenAt.Equal(now) {
		t.Fatalf("nullable timestamp broken")
	}
	var id NodeIdentity
	if id.EnrolledAt != nil {
		t.Fatalf("zero-value nullable should be nil")
	}
}
