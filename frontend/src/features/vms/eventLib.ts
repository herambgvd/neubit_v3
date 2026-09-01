"use client";

// Shared derivations for the VMS camera-events feed / timeline markers. Keeps the
// preset lookups + label/time helpers in one place so CameraEvents, CameraEventRow,
// and the ScrubBar markers agree. JSX-free (data + string helpers only).

import { EVENT_TYPE_PRESETS, SEVERITY_PRESETS } from "./constants";

export const typePreset = (t) => EVENT_TYPE_PRESETS[t] || EVENT_TYPE_PRESETS.system;
export const sevPreset = (s) => SEVERITY_PRESETS[s] || SEVERITY_PRESETS.info;

export const eventTypeLabel = (t) => typePreset(t).label;
export const eventTypeIcon = (t) => typePreset(t).icon;

// A stable de-dupe / React key for an event across history + live SSE.
export function eventKey(e, idx = 0) {
  const base = e?.id || e?.event_id || `${e?.camera_id || "cam"}:${e?.occurred_at || "ts"}:${e?.event_type || "t"}`;
  return `${base}:${idx}`;
}

// Normalize a history row (VmsEventPublic) or a live SSE frame to ONE shape so the
// renderers work identically across both. Idempotent.
export function normalizeVmsEvent(e) {
  if (!e || typeof e !== "object") return e;
  return {
    ...e,
    id: e.id || e.event_id,
    event_id: e.event_id || e.id,
    severity: e.severity || "info",
    occurred_at: e.occurred_at || e.created_at || e.timestamp,
    raw: e.raw || {},
    acknowledged: !!e.acknowledged,
  };
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString();
}
