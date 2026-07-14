// Package events is the NATS + JetStream event-bus client for Go services,
// mirroring the Python kernel (backend/kernel/kernel/events.py) so the two
// languages interoperate on ONE spine:
//
//   - stream:   EVENTS, subjects ["tenant.>"]
//   - subject:  tenant.<id>.<domain>.<event>   (tenant_id nil → "platform")
//   - envelope: { event_id, tenant_id, type, occurred_at, source, payload }
//
// A Go-published event unmarshals in Python and vice-versa (the envelope key
// order is irrelevant to JSON; field names + types match exactly). If VE_NATS_URL
// is empty the bus is a no-op, so a service still runs standalone.
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

// Subject builds a JetStream subject. A nil tenant → the "platform" namespace,
// identical to the Python subject() helper.
func Subject(tenantID *string, domain, event string) string {
	tid := "platform"
	if tenantID != nil && *tenantID != "" {
		tid = *tenantID
	}
	return fmt.Sprintf("tenant.%s.%s.%s", tid, domain, event)
}

// Envelope is the canonical event body every service emits. Field names + JSON
// tags match the Python kernel's envelope() dict exactly.
type Envelope struct {
	EventID    string         `json:"event_id"`
	TenantID   *string        `json:"tenant_id"`
	Type       string         `json:"type"`
	OccurredAt string         `json:"occurred_at"`
	Source     string         `json:"source"`
	Payload    map[string]any `json:"payload"`
}

// NewEnvelope constructs an Envelope with a fresh event_id and an RFC3339 UTC
// timestamp (Python emits datetime.now(utc).isoformat(); both are ISO-8601).
func NewEnvelope(tenantID *string, typ, source string, payload map[string]any) Envelope {
	if payload == nil {
		payload = map[string]any{}
	}
	return Envelope{
		EventID:    uuid.NewString(),
		TenantID:   tenantID,
		Type:       typ,
		OccurredAt: time.Now().UTC().Format("2006-01-02T15:04:05.000000-07:00"),
		Source:     source,
		Payload:    payload,
	}
}

// Handler receives a decoded envelope.
type Handler func(context.Context, Envelope) error

// Bus is a thin JetStream client. One per service: Connect at startup, Close at
// shutdown. Nil-safe when NATS is disabled.
type Bus struct {
	source string
	url    string
	nc     *nats.Conn
	js     nats.JetStreamContext
}

// NewBus builds a bus. source names the emitter (the envelope `source` field).
func NewBus(source, natsURL string) *Bus {
	return &Bus{source: source, url: natsURL}
}

// Connect dials NATS and ensures the EVENTS stream exists. No-op if the URL is
// empty (degrades gracefully, exactly like the Python kernel).
func (b *Bus) Connect() error {
	if b.url == "" {
		log.Printf("NATS disabled (VE_NATS_URL unset) — events are no-ops")
		return nil
	}
	nc, err := nats.Connect(b.url, nats.Name("neubit-"+b.source))
	if err != nil {
		// Match the Python kernel: log + degrade to no-op rather than crash boot.
		log.Printf("NATS connect failed (%v) — events are no-ops", err)
		return nil
	}
	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		log.Printf("JetStream unavailable (%v) — events are no-ops", err)
		return nil
	}
	// Create the shared stream if the first-connecting service hasn't already.
	_, err = js.AddStream(&nats.StreamConfig{Name: "EVENTS", Subjects: []string{"tenant.>"}})
	if err != nil && !strings.Contains(err.Error(), "already") && !strings.Contains(err.Error(), "in use") {
		// A concurrent create or a differing pre-existing config is fine.
		log.Printf("NATS stream ensure note: %v", err)
	}
	b.nc, b.js = nc, js
	log.Printf("NATS connected: %s", b.url)
	return nil
}

// Close drains the connection.
func (b *Bus) Close() {
	if b.nc != nil {
		_ = b.nc.Drain()
		b.nc = nil
		b.js = nil
	}
}

// IsConnected reports whether a live connection exists.
func (b *Bus) IsConnected() bool { return b.nc != nil }

// Publish enveloping payload onto subj. No-op if NATS is unavailable. The
// tenant_id + type in the envelope are re-derived from the subject so consumers
// see the same shape a Python publish produces.
func (b *Bus) Publish(subj string, payload map[string]any) error {
	if b.js == nil {
		return nil
	}
	tenantID, typ := parseSubject(subj)
	env := NewEnvelope(tenantID, typ, b.source, payload)
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	_, err = b.js.Publish(subj, data)
	return err
}

// Subscribe delivers decoded envelopes matching pattern to handler. Pass a
// non-empty durable for an at-least-once JetStream durable consumer (survives
// restarts); empty durable → an ephemeral core subscription.
func (b *Bus) Subscribe(pattern string, handler Handler, durable string) error {
	if b.nc == nil {
		return nil
	}
	cb := func(msg *nats.Msg) {
		var env Envelope
		if err := json.Unmarshal(msg.Data, &env); err != nil {
			log.Printf("event decode error on %s: %v", pattern, err)
			return
		}
		if err := handler(context.Background(), env); err != nil {
			log.Printf("event handler error on %s: %v", pattern, err)
		}
	}
	if durable != "" && b.js != nil {
		_, err := b.js.Subscribe(pattern, cb, nats.Durable(durable), nats.ManualAck())
		return err
	}
	_, err := b.nc.Subscribe(pattern, cb)
	return err
}

// parseSubject: `tenant.<id>.<domain>.<event>` → (tenant_id_or_nil, "<domain>.<event>").
// Mirrors the Python _parse_subject().
func parseSubject(subj string) (*string, string) {
	parts := strings.Split(subj, ".")
	if len(parts) >= 4 && parts[0] == "tenant" {
		tid := parts[1]
		typ := strings.Join(parts[2:], ".")
		if tid == "platform" {
			return nil, typ
		}
		return &tid, typ
	}
	return nil, subj
}
