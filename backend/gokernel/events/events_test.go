package events

import (
	"encoding/json"
	"testing"
)

func TestSubject(t *testing.T) {
	tid := "t-123"
	if got := Subject(&tid, "device", "camera.registered"); got != "tenant.t-123.device.camera.registered" {
		t.Errorf("subject = %s", got)
	}
	if got := Subject(nil, "access", "startup"); got != "tenant.platform.access.startup" {
		t.Errorf("platform subject = %s", got)
	}
}

func TestParseSubject(t *testing.T) {
	tid, typ := parseSubject("tenant.abc.vms.camera.status")
	if tid == nil || *tid != "abc" || typ != "vms.camera.status" {
		t.Errorf("parse = %v / %s", tid, typ)
	}
	tid, typ = parseSubject("tenant.platform.access.startup")
	if tid != nil || typ != "access.startup" {
		t.Errorf("platform parse = %v / %s", tid, typ)
	}
}

// TestEnvelope_PythonParity decodes an envelope produced by the Python kernel's
// envelope() dict (backend/kernel/kernel/events.py) and asserts every field
// round-trips. A Go Envelope must unmarshal a Python-published event 1:1.
func TestEnvelope_PythonParity(t *testing.T) {
	// This is exactly what kernel.events.envelope() serializes with json.dumps.
	pyBytes := []byte(`{
		"event_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
		"tenant_id": "t-777",
		"type": "device.camera.registered",
		"occurred_at": "2026-07-08T10:30:00.123456+00:00",
		"source": "vision",
		"payload": {"camera_id": "cam-1", "brand": "onvif", "channel": 3}
	}`)

	var env Envelope
	if err := json.Unmarshal(pyBytes, &env); err != nil {
		t.Fatalf("unmarshal python envelope: %v", err)
	}
	if env.EventID != "3f2504e0-4f89-41d3-9a0c-0305e82c3301" {
		t.Errorf("event_id = %s", env.EventID)
	}
	if env.TenantID == nil || *env.TenantID != "t-777" {
		t.Errorf("tenant_id = %v", env.TenantID)
	}
	if env.Type != "device.camera.registered" {
		t.Errorf("type = %s", env.Type)
	}
	if env.Source != "vision" {
		t.Errorf("source = %s", env.Source)
	}
	if env.Payload["camera_id"] != "cam-1" {
		t.Errorf("payload.camera_id = %v", env.Payload["camera_id"])
	}

	// And a Go-built envelope must marshal to the SAME field set (keys the Python
	// consumer expects). Verify the JSON has exactly these top-level keys.
	tid := "t-777"
	built := NewEnvelope(&tid, "vms.camera.status", "nvr", map[string]any{"status": "online"})
	raw, _ := json.Marshal(built)
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	for _, k := range []string{"event_id", "tenant_id", "type", "occurred_at", "source", "payload"} {
		if _, ok := m[k]; !ok {
			t.Errorf("go envelope missing field %q (Python consumers require it)", k)
		}
	}
	if len(m) != 6 {
		t.Errorf("go envelope has %d fields, want 6 (extra fields would surprise Python consumers): %v", len(m), keys(m))
	}
}

// TestEnvelope_PlatformTenant confirms a nil tenant serializes as JSON null,
// matching Python's tenant_id: None.
func TestEnvelope_PlatformTenant(t *testing.T) {
	env := NewEnvelope(nil, "access.startup", "core", nil)
	raw, _ := json.Marshal(env)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["tenant_id"] != nil {
		t.Errorf("nil tenant must serialize as null, got %v", m["tenant_id"])
	}
	if p, ok := m["payload"].(map[string]any); !ok || len(p) != 0 {
		t.Errorf("nil payload must serialize as {}, got %v", m["payload"])
	}
}

func keys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
