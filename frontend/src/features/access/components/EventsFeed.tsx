"use client";

// Live access-event feed for a single instance. Ported from neubit_v2's
// events-feed.jsx — SAME toolbar (result + door filters, Pause, Clear live,
// Reload, Heartbeat, Auto-scroll), category chips, Security-Alerts summary,
// and expandable event rows with raw-payload JSON.
//
// v3 data source: an INITIAL history fetch via GET /access/instances/{id}/events
// (one request, like v2's initial load) + LIVE appends over the core realtime SSE
// bridge (GET /api/v1/realtime/access-events, per-instance). No more 5s polling;
// Pause simply closes the SSE stream. Both history rows and live frames are
// normalized to one shape so every renderer/helper works against the combined list.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import type { AccessDoorPublic } from "@/lib/types";
import { gates } from "../api";
import { RESULT_OPTIONS, EVENT_CATEGORIES } from "../constants";
import { useAccessEventStream } from "../hooks/useAccessEventStream";
import type {
  AccessCardholder,
  AccessEventFrame,
  AccessEventPublic,
  NormalizedAccessEvent,
  RawAccessEvent,
} from "../types";

/** The doors of this instance, keyed for the filter + label lookups by the
 *  CONTROLLER ref an event carries (`remote_ref`), falling back to the local id. */
type DoorIndex = Record<string, AccessDoorPublic>;
/** Cardholders keyed by DDS UID — what an event's `cardholder_ref` holds. */
type CardholderIndex = Record<string, AccessCardholder>;

/** The three resolved labels a row/alert renders. */
interface EventLabels {
  doorLabel?: string | null;
  cardholderLabel?: string | null;
  cardLabel?: string | null;
}

export interface EventsFeedProps {
  instanceId: string;
  /** GET /access/doors?instance_id= — drives the door filter and label lookups. */
  doorIndex?: AccessDoorPublic[] | null;
}

export default function EventsFeed({ instanceId, doorIndex }: EventsFeedProps) {
  const qc = useQueryClient();
  const [paused, setPaused] = useState(false);
  const [showHeartbeat, setShowHeartbeat] = useState(false);
  const [category, setCategory] = useState("all");
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [doorRef, setDoorRef] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const previousTopEventRef = useRef("");

  // Initial history — one fetch (no polling). Live updates arrive over SSE below.
  const q = useQuery({
    queryKey: ["ac-events", instanceId, result, doorRef],
    queryFn: () =>
      gates.events.list(instanceId, {
        limit: 200,
        result: result || undefined,
        door_ref: doorRef || undefined,
      }),
    enabled: !!instanceId,
    refetchOnWindowFocus: false,
  });

  // Live appends over the core realtime SSE bridge. Pause closes the stream.
  const { events: liveEvents, connected } = useAccessEventStream(instanceId, {
    enabled: !paused,
  });

  const cardholdersQ = useQuery({
    queryKey: ["ac-cardholders", instanceId],
    queryFn: () => gates.cardholders.list(instanceId, { limit: 500 }),
    enabled: !!instanceId,
    staleTime: 60_000,
  });

  // Merge live SSE frames (newest-first) ahead of the fetched history, dedupe by
  // event id, and normalize every record to one shape so the filters + renderers
  // work identically across both sources.
  const historyEvents = useMemo(() => asItems(q.data).map(normalizeEvent), [q.data]);
  const events = useMemo(() => {
    const seen = new Set<string>();
    const merged: NormalizedAccessEvent[] = [];
    for (const raw of [...liveEvents, ...historyEvents]) {
      const e = normalizeEvent(raw);
      const key = e.event_id;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(e);
    }
    // Respect the current result/door filters against the live-merged list too.
    return merged.filter((e) => {
      if (result && String(e.result || "").toLowerCase() !== result.toLowerCase()) return false;
      if (doorRef && e.door_ref !== doorRef && e.door_id !== doorRef) return false;
      return true;
    });
  }, [liveEvents, historyEvents, result, doorRef]);

  const cardholders = useMemo(() => asItems(cardholdersQ.data), [cardholdersQ.data]);

  const cardholderById = useMemo<CardholderIndex>(
    () => Object.fromEntries(cardholders.map((ch) => [ch.cardholder_id, ch] as const)),
    [cardholders],
  );
  // Keyed by the controller ref the events carry. `DoorPublic` has no `door_id`
  // (that was the v2 field name), so the old key was undefined for every door —
  // the filter and every door label resolved to nothing.
  const doorById = useMemo<DoorIndex>(
    () => Object.fromEntries((doorIndex || []).map((d) => [doorKey(d), d] as const)),
    [doorIndex],
  );

  const categorizedEvents = useMemo(() => {
    if (category === "all") return events;
    return events.filter((e) => eventCategory(e) === category);
  }, [events, category]);

  const eventsAfterClear = useMemo(() => {
    if (!clearedAt) return categorizedEvents;
    const t = new Date(clearedAt).getTime();
    return categorizedEvents.filter((e) => {
      const ts = Date.parse(e.timestamp || e.ingested_at || "");
      return Number.isFinite(ts) && ts >= t;
    });
  }, [categorizedEvents, clearedAt]);

  const visibleEvents = useMemo(() => {
    if (showHeartbeat || category === "health") return eventsAfterClear;
    return eventsAfterClear.filter((e) => !isHeartbeat(e));
  }, [eventsAfterClear, showHeartbeat, category]);

  const securityAlerts = useMemo(() => {
    const relevant = visibleEvents.filter((evt) => isUnknownAccess(evt) || isAuthorizedAccess(evt));
    const grouped: { evt: NormalizedAccessEvent; count: number }[] = [];
    const bySig = new Map<string, number>();
    for (const evt of relevant) {
      const sig = alertSignature(evt, cardholderById, doorById);
      const idx = bySig.get(sig);
      if (idx !== undefined) {
        grouped[idx].count += 1;
        continue;
      }
      if (grouped.length >= 8) continue;
      bySig.set(sig, grouped.length);
      grouped.push({ evt, count: 1 });
    }
    return grouped;
  }, [visibleEvents, cardholderById, doorById]);

  // Toast on new granted/denied events.
  useEffect(() => {
    if (!visibleEvents.length) return;
    const newest = visibleEvents[0];
    const marker = newest.event_id || `${newest.timestamp}-${newest.result}-${newest.card_id || ""}`;
    if (previousTopEventRef.current === marker) return;
    if (previousTopEventRef.current) {
      const r = String(newest.result || "").toLowerCase();
      const who = resolveCardholderLabel(newest, cardholderById) || resolveCardLabel(newest) || "Unknown";
      const where = resolveDoorLabel(newest, doorById);
      const why = newest.reason ? `Reason: ${newest.reason}` : "";
      if (r === "granted" || r === "opened") {
        toast.success("Access Granted", {
          description: [who, where ? `@ ${where}` : ""].filter(Boolean).join(" "),
          duration: 5000,
        });
      } else if (r === "denied" || r === "unknown_card" || r === "forced" || r === "tamper") {
        toast.error("Access Denied", { description: [who, where, why].filter(Boolean).join(" · "), duration: 6000 });
      }
    }
    previousTopEventRef.current = marker;
  }, [visibleEvents, cardholderById, doorById]);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
  }, [visibleEvents, autoScroll]);

  const selectCls =
    "rounded-md border border-field bg-transparent px-2 py-1 text-[11px] text-muted outline-hidden focus:border-muted";
  const btnCls =
    "inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground";

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border pb-3">
        <Icon icon="heroicons-outline:signal" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Live events</span>
        <span className="rounded-sm bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{visibleEvents.length}</span>
        <span className="ml-2 text-[10px] text-muted/70">
          {paused ? "paused" : connected ? "live" : "connecting…"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <select value={result} onChange={(e) => setResult(e.target.value)} className={selectCls}>
            {RESULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="bg-card">
                {o.label}
              </option>
            ))}
          </select>

          {doorIndex && doorIndex.length > 0 && (
            <select value={doorRef} onChange={(e) => setDoorRef(e.target.value)} className={selectCls}>
              <option value="" className="bg-card">
                All doors
              </option>
              {doorIndex.map((d) => (
                <option key={d.id} value={doorKey(d)} className="bg-card">
                  {d.name}
                </option>
              ))}
            </select>
          )}

          <button type="button" onClick={() => setPaused((p) => !p)} className={btnCls}>
            <Icon icon={paused ? "heroicons-outline:play" : "heroicons-outline:pause"} className="text-xs" />
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" onClick={() => setClearedAt(new Date().toISOString())} className={btnCls}>
            <Icon icon="heroicons-outline:trash" className="text-xs" /> Clear live
          </button>
          <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ["ac-events"] })} className={btnCls}>
            <Icon icon="heroicons-outline:arrow-path" className="text-xs" /> Reload history
          </button>
          <button
            type="button"
            onClick={() => setShowHeartbeat((v) => !v)}
            className={
              showHeartbeat
                ? "inline-flex items-center gap-1 rounded-md border border-foreground px-2 py-1 text-[11px] font-medium text-foreground"
                : btnCls
            }
          >
            <Icon icon="heroicons-outline:signal" className="text-xs" /> Heartbeat
          </button>
          <label className="inline-flex items-center gap-1 text-[11px] text-muted">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            <span>Auto-scroll</span>
          </label>
        </div>

        <div className="flex items-center gap-1">
          {EVENT_CATEGORIES.map((c) => {
            const active = category === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                className={`rounded-sm border px-2 py-0.5 text-[11px] font-medium ${
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-card-border text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pt-2">
        {securityAlerts.length > 0 ? (
          <div className="mx-2 mb-2 rounded-lg border border-card-border bg-card p-2">
            <div className="px-1 text-[11px] font-semibold text-foreground">Security Alerts</div>
            <div className="mt-1 space-y-1">
              {securityAlerts.slice(0, 3).map(({ evt, count }, idx) => {
                const unknown = isUnknownAccess(evt);
                const doorLabel = resolveDoorLabel(evt, doorById);
                const cardholderLabel = resolveCardholderLabel(evt, cardholderById);
                const cardLabel = resolveCardLabel(evt);
                return (
                  <div
                    key={`alert:${eventKey(evt, idx)}`}
                    className={`flex items-center gap-2 rounded-sm px-2 py-1 text-[11px] ${
                      unknown ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"
                    }`}
                  >
                    <Icon
                      icon={unknown ? "heroicons-outline:shield-exclamation" : "heroicons-outline:shield-check"}
                      className="shrink-0 text-sm"
                    />
                    <span className="font-medium">{unknown ? "Unknown Card" : "Authorized Access"}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {summarize(evt, { doorLabel, cardholderLabel, cardLabel })}
                    </span>
                    {count > 1 ? (
                      <span className="ml-auto shrink-0 rounded-sm bg-black/10 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-white/10">
                        x{count}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {q.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading events…
          </div>
        ) : q.isError ? (
          <div className="mx-2 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
            <Icon icon="heroicons-outline:exclamation-circle" className="mt-0.5 shrink-0 text-sm" />
            <div>
              <p className="font-medium">Failed to load events</p>
              <p className="mt-0.5 text-[11px] opacity-80">{apiError(q.error, "Unknown error")}</p>
            </div>
          </div>
        ) : visibleEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Icon icon="heroicons-outline:signal" className="mb-2 text-2xl text-muted" />
            <p className="text-xs text-muted">No events yet</p>
            <p className="text-[11px] text-muted/70">
              {showHeartbeat
                ? "No events yet."
                : "No security events yet. Enable Heartbeat to see status updates."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-card-border">
            {visibleEvents.map((e, idx) => (
              <EventRow key={eventKey(e, idx)} event={e} cardholderById={cardholderById} doorById={doorById} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface EventRowProps {
  event: NormalizedAccessEvent;
  cardholderById: CardholderIndex;
  doorById: DoorIndex;
}

function EventRow({ event, cardholderById, doorById }: EventRowProps) {
  const [open, setOpen] = useState(false);
  const result = String(event.result || "").toLowerCase();
  const category = eventCategory(event);
  const typeLabel = eventTypeLabel(event);
  const doorLabel = resolveDoorLabel(event, doorById);
  const cardholderLabel = resolveCardholderLabel(event, cardholderById);
  const cardLabel = resolveCardLabel(event);
  const tone =
    result === "granted" || result === "opened"
      ? "bg-emerald-500/10 text-emerald-500"
      : result === "denied" || result === "unknown_card"
        ? "bg-red-500/10 text-red-500"
        : result === "forced" || result === "tamper"
          ? "bg-amber-500/10 text-amber-500"
          : "bg-hover text-muted";

  return (
    <div className="px-2 py-2 text-xs hover:bg-hover/50">
      <button type="button" onClick={() => setOpen((o) => !o)} className="grid w-full grid-cols-[100px_1fr] gap-2 text-left">
        <div className="font-mono text-[11px] leading-tight text-muted">
          <div>{formatTime(event.timestamp)}</div>
          <div className="mt-0.5 text-[10px] text-muted/70">{formatDate(event.timestamp)}</div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {category === "access" ? (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}>
                {isUnknownAccess(event) ? "Denied" : isAuthorizedAccess(event) ? "Granted" : event.result || "Other"}
              </span>
            ) : (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-500">
                {category.toUpperCase()}
              </span>
            )}
            <span className="font-medium text-foreground">{typeLabel}</span>
            <Icon
              icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"}
              className="ml-auto shrink-0 text-xs text-muted"
            />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {event.reason || summarize(event, { doorLabel, cardholderLabel, cardLabel })}
          </div>
        </div>
      </button>
      {open && (
        <div className="mt-2 ml-5 grid grid-cols-3 gap-2 text-[10px] text-muted">
          <MetaField label="Door" value={withId(doorLabel, event.door_id || event.door_ref)} />
          <MetaField label="Cardholder" value={withId(cardholderLabel, event.cardholder_id || event.cardholder_ref)} />
          <MetaField label="Card" value={withId(cardLabel, event.card_id)} />
          {event.raw_payload && (
            <pre className="col-span-3 mt-1 max-h-48 overflow-auto rounded-sm border border-card-border bg-hover p-2 font-mono text-[10px] text-muted">
              {JSON.stringify(event.raw_payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface MetaFieldProps {
  label: ReactNode;
  value: ReactNode;
}

function MetaField({ label, value }: MetaFieldProps) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted/70">{label}</div>
      <div className="truncate font-mono text-[10px] text-muted">{value || "—"}</div>
    </div>
  );
}

/* ── event normalization ──────────────────────────────────────────────
 * Both the REST history rows (AccessEventPublic: {id, occurred_at, raw,
 * door_ref, cardholder_ref, event_type, ...}) and the live SSE frames (same
 * fields) get mapped to ONE shape so every filter/renderer/helper below —
 * which keys off event_id / timestamp / raw_payload / door_id / cardholder_id /
 * card_id — works identically across both sources. Idempotent: re-normalizing an
 * already-normalized record is a no-op.
 */
function normalizeEvent(e: RawAccessEvent): NormalizedAccessEvent {
  // The record still arrives off the wire, so the object guard stays; the union
  // above makes it unreachable for every call site in this file.
  if (!e || typeof e !== "object") return e as NormalizedAccessEvent;
  // One widened view of the three source shapes — each key below exists on at
  // least one of them, and the folds pick whichever the record actually carries.
  const src = e as Partial<AccessEventPublic & AccessEventFrame & NormalizedAccessEvent>;
  const raw = src.raw_payload || src.raw || {};
  return {
    ...src,
    event_id: src.event_id || src.id || null,
    timestamp: src.timestamp || src.occurred_at || src.ingested_at || null,
    raw_payload: raw,
    // Keep both the *_ref (v3 controller refs) and *_id aliases the helpers read.
    door_ref: src.door_ref ?? src.door_id ?? null,
    door_id: src.door_id ?? src.door_ref ?? null,
    cardholder_ref: src.cardholder_ref ?? src.cardholder_id ?? null,
    cardholder_id: src.cardholder_id ?? src.cardholder_ref ?? null,
    card_id: src.card_id ?? pickText(raw, "CardCode", "cardCode"),
  } as NormalizedAccessEvent;
}

/** The key `doorById` uses and the door filter sends: an event's `door_ref` is
 *  the CONTROLLER's ref, so match on `remote_ref` and fall back to the local id
 *  for a door the mirror has not linked yet. */
function doorKey(door: AccessDoorPublic): string {
  return door.remote_ref || door.id;
}

/* ── helpers (ported verbatim from v2, snake_case fields) ─────────── */

function summarize(event: NormalizedAccessEvent, labels: EventLabels = {}) {
  const parts: string[] = [];
  if (labels.cardholderLabel) parts.push(labels.cardholderLabel);
  else if (labels.cardLabel) parts.push(`Card ${labels.cardLabel}`);
  if (labels.doorLabel) parts.push(`at ${labels.doorLabel}`);
  const deniedCode = deniedCodeOf(event);
  if (deniedCode !== null && deniedCode !== "" && deniedCode !== "0" && deniedCode !== 0) {
    parts.push(`Denied code ${deniedCode}`);
  }
  return parts.join(" • ") || "—";
}

function eventTypeLabel(event: NormalizedAccessEvent): string {
  const p = event.raw_payload || {};
  const rawType = String(pickText(p, "Type", "type", "EventType", "eventType") || "").trim();
  if (!rawType) return event.event_type || event.reason || "—";
  if (rawType === "1") return "Access Granted (Type 1)";
  if (rawType === "2") return "Access Denied (Type 2)";
  if (rawType === "3") return "Unknown Card (Type 3)";
  if (/^\d+$/.test(rawType)) return `Access Event (Type ${rawType})`;
  return rawType;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString();
}

function isHeartbeat(event: NormalizedAccessEvent): boolean {
  const t = eventTypeOf(event);
  if (t.includes("statusupdate")) return true;
  if (String(event.result || "").toLowerCase() === "other" && !event.cardholder_id && !event.card_id) return true;
  return false;
}

function isAuthorizedAccess(event: NormalizedAccessEvent): boolean {
  const result = String(event?.result || "").toLowerCase();
  const t = eventTypeOf(event);
  const denied = deniedCodeOf(event);
  if (denied && denied !== "0" && denied !== 0) return false;
  if (result === "granted" || result === "opened") return true;
  return t === "1" || /accessgranted|authorized|granted/.test(t);
}

function isUnknownAccess(event: NormalizedAccessEvent): boolean {
  const result = String(event?.result || "").toLowerCase();
  if (result === "denied" || result === "unknown_card" || result === "forced" || result === "tamper") return true;
  const deniedCode = deniedCodeOf(event);
  if (deniedCode !== null && deniedCode !== "" && deniedCode !== "0" && deniedCode !== 0) return true;
  const t = eventTypeOf(event);
  return /^[2-9]$|^[1-9]\d+$/.test(t) || /unknowncard|denied|accessdenied/.test(t);
}

function eventCategory(event: NormalizedAccessEvent): string {
  const explicit = String(event?.category || "").toLowerCase();
  if (explicit) return explicit;
  const t = eventTypeOf(event);
  if (t.includes("statusupdate")) return "health";
  if (t.includes("ioevent")) return "io";
  if (t.includes("alarm")) return "alarm";
  if (t.includes("audit")) return "audit";
  if (t.includes("comm")) return "comm";
  if (t.includes("technical")) return "technical";
  if (t.includes("general")) return "general";
  return "access";
}

function eventTypeOf(event: NormalizedAccessEvent): string {
  return (
    pickText(event?.raw_payload || {}, "Type", "type", "EventType", "eventType") ||
    event?.event_type ||
    event?.reason ||
    ""
  ).toLowerCase();
}

function deniedCodeOf(event: NormalizedAccessEvent): string | number | null {
  return pickScalar(event?.raw_payload || {}, "AccessDeniedCode", "accessDeniedCode");
}

function alertSignature(event: NormalizedAccessEvent, cardholderById: CardholderIndex, doorById: DoorIndex): string {
  const kind = isUnknownAccess(event) ? "unknown" : "authorized";
  const card = resolveCardLabel(event) || "-";
  const door = resolveDoorLabel(event, doorById) || event.door_id || "-";
  const holder = resolveCardholderLabel(event, cardholderById) || event.cardholder_id || "-";
  return `${kind}|${card}|${door}|${holder}`;
}

/** First non-empty value among `keys`. The vendor payload is genuinely dynamic,
 *  so the value stays `unknown` and each caller narrows it. */
function pick(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = obj?.[key];
    if (value === undefined || value === null) continue;
    // Only a string can be blank-but-present; everything else counts as a value.
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

/** `pick` narrowed to a scalar. The vendor payload is dynamic enough to hand
 *  back a nested object where a code is expected; such a value is not a code, so
 *  it reads as absent rather than reaching an operator as `[object Object]`. */
function pickScalar(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | number | null {
  const value = pick(obj, ...keys);
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/** `pick` narrowed to the text a label renderer can show; a picked value that is
 *  neither string nor number has no label to render, hence null. */
function pickText(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  const value = pick(obj, ...keys);
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function resolveDoorLabel(event: NormalizedAccessEvent, doorById: DoorIndex): string | null {
  const p = event.raw_payload || {};
  return (
    pickText(p, "ReaderName", "readerName", "DoorName", "doorName") ||
    (event.door_id ? doorById?.[event.door_id]?.name : null) ||
    (event.door_ref ? doorById?.[event.door_ref]?.name : null) ||
    null
  );
}

function resolveCardholderLabel(event: NormalizedAccessEvent, cardholderById: CardholderIndex): string | null {
  const p = event.raw_payload || {};
  const first = pickText(p, "CardholderFirstName", "cardholderFirstName", "FirstName", "firstName");
  const last = pickText(p, "CardholderLastName", "cardholderLastName", "LastName", "lastName");
  const payloadName =
    [first, last].filter(Boolean).join(" ").trim() || pickText(p, "CardholderName", "cardholderName", "Name", "name");
  if (payloadName) return payloadName;
  const mapped =
    (event.cardholder_id ? cardholderById?.[event.cardholder_id] : undefined) ||
    (event.cardholder_ref ? cardholderById?.[event.cardholder_ref] : undefined);
  if (mapped?.name) return mapped.name;
  if (mapped?.employee_id) return mapped.employee_id;
  return null;
}

function resolveCardLabel(event: NormalizedAccessEvent): string | null {
  const p = event.raw_payload || {};
  return pickText(p, "CardCode", "cardCode") || event.card_id || null;
}

function withId(label: string | null | undefined, id: string | null | undefined): string {
  if (label && id) return `${label} (${shortId(id)})`;
  return label || id || "—";
}

function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return String(id).length > 8 ? `${String(id).slice(0, 8)}…` : id;
}

function eventKey(event: NormalizedAccessEvent, idx: number): string {
  // `event_id` already folds in the REST row's `id` (see normalizeEvent).
  const base =
    event.event_id ||
    `${event.instance_id || "inst"}:${event.timestamp || "ts"}:${event.cardholder_id || "ch"}:${event.card_id || "card"}`;
  return `${base}:${idx}`;
}
