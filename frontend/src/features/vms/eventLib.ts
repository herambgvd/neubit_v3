"use client";

// Shared derivations for the VMS camera-events feed / timeline markers. Keeps the
// preset lookups + label/time helpers in one place so CameraEvents, CameraEventRow,
// and the ScrubBar markers agree. JSX-free (data + string helpers only).

import type { DateInput } from "@/lib/format";
import { EVENT_TYPE_PRESETS, SEVERITY_PRESETS, presetFor } from "./constants";
import type { VmsEventFrame } from "./types";

export type EventTypePreset = (typeof EVENT_TYPE_PRESETS)[keyof typeof EVENT_TYPE_PRESETS];
export type SeverityPreset = (typeof SEVERITY_PRESETS)[keyof typeof SEVERITY_PRESETS];

export const typePreset = (t: string | null | undefined): EventTypePreset =>
  presetFor(EVENT_TYPE_PRESETS, t, EVENT_TYPE_PRESETS.system);
export const sevPreset = (s: string | null | undefined): SeverityPreset =>
  presetFor(SEVERITY_PRESETS, s, SEVERITY_PRESETS.info);

export const eventTypeLabel = (t: string | null | undefined): string => typePreset(t).label;
export const eventTypeIcon = (t: string | null | undefined): string => typePreset(t).icon;

// A stable de-dupe / React key for an event across history + live SSE.
export function eventKey(e: VmsEventFrame | null | undefined, idx = 0): string {
  const base = e?.id || e?.event_id || `${e?.camera_id || "cam"}:${e?.occurred_at || "ts"}:${e?.event_type || "t"}`;
  return `${base}:${idx}`;
}

/** A history row or a live frame after `normalizeVmsEvent` — one shape for the
 *  renderers. `id`/`event_id` mirror each other; `occurred_at` is whichever
 *  timestamp the source carried. */
export interface NormalizedVmsEvent extends VmsEventFrame {
  id?: string;
  event_id?: string;
  severity: string;
  occurred_at?: string;
  raw: Record<string, unknown>;
  acknowledged: boolean;
}

// Normalize a history row (VmsEventPublic) or a live SSE frame to ONE shape so the
// renderers work identically across both. Idempotent.
export function normalizeVmsEvent(e: VmsEventFrame | null | undefined): NormalizedVmsEvent | null | undefined {
  if (!e || typeof e !== "object") return e as null | undefined;
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

export function fmtTime(iso: DateInput): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDate(iso: DateInput): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString();
}
