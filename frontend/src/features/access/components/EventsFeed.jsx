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
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";
import { RESULT_OPTIONS, EVENT_CATEGORIES } from "../constants";
import { useAccessEventStream } from "../hooks/useAccessEventStream";

export default function EventsFeed({ instanceId, doorIndex }) {
  const qc = useQueryClient();
  const [paused, setPaused] = useState(false);
  const [showHeartbeat, setShowHeartbeat] = useState(false);
  const [category, setCategory] = useState("all");
  const [clearedAt, setClearedAt] = useState(null);
  const [result, setResult] = useState("");
  const [doorRef, setDoorRef] = useState("");
  const scrollRef = useRef(null);
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
    const seen = new Set();
    const merged = [];
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

  const cardholderById = useMemo(
    () => Object.fromEntries(cardholders.map((ch) => [ch.cardholder_id, ch])),
    [cardholders],
  );
  const doorById = useMemo(
    () => Object.fromEntries((doorIndex || []).map((d) => [d.door_id, d])),
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
    const grouped = [];
    const bySig = new Map();
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
    "rounded-md border border-field bg-transparent px-2 py-1 text-[11px] text-muted outline-none focus:border-muted";
  const btnCls =
    "inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground";

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border pb-3">
        <Icon icon="heroicons-outline:signal" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Live events</span>
        <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{visibleEvents.length}</span>
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
                <option key={d.door_id} value={d.door_id} className="bg-card">
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
            Auto-scroll
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
                className={`rounded border px-2 py-0.5 text-[11px] font-medium ${
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
                    className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] ${
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
                      <span className="ml-auto shrink-0 rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-white/10">
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

function EventRow({ event, cardholderById, doorById }) {
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
            <pre className="col-span-3 mt-1 max-h-48 overflow-auto rounded border border-card-border bg-hover p-2 font-mono text-[10px] text-muted">
              {JSON.stringify(event.raw_payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function MetaField({ label, value }) {
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
function normalizeEvent(e) {
  if (!e || typeof e !== "object") return e;
  const raw = e.raw_payload || e.raw || {};
  return {
    ...e,
    event_id: e.event_id || e.id,
    timestamp: e.timestamp || e.occurred_at || e.ingested_at,
    raw_payload: raw,
    // Keep both the *_ref (v3 controller refs) and *_id aliases the helpers read.
    door_ref: e.door_ref ?? e.door_id ?? null,
    door_id: e.door_id ?? e.door_ref ?? null,
    cardholder_ref: e.cardholder_ref ?? e.cardholder_id ?? null,
    cardholder_id: e.cardholder_id ?? e.cardholder_ref ?? null,
    card_id: e.card_id ?? pick(raw, "CardCode", "cardCode") ?? null,
  };
}

/* ── helpers (ported verbatim from v2, snake_case fields) ─────────── */

function summarize(event, labels = {}) {
  const parts = [];
  if (labels.cardholderLabel) parts.push(labels.cardholderLabel);
  else if (labels.cardLabel) parts.push(`Card ${labels.cardLabel}`);
  if (labels.doorLabel) parts.push(`at ${labels.doorLabel}`);
  const deniedCode = deniedCodeOf(event);
  if (deniedCode !== null && deniedCode !== "" && deniedCode !== "0" && deniedCode !== 0) {
    parts.push(`Denied code ${deniedCode}`);
  }
  return parts.join(" • ") || "—";
}

function eventTypeLabel(event) {
  const p = event.raw_payload || {};
  const rawType = String(pick(p, "Type", "type", "EventType", "eventType") || "").trim();
  if (!rawType) return event.event_type || event.reason || "—";
  if (rawType === "1") return "Access Granted (Type 1)";
  if (rawType === "2") return "Access Denied (Type 2)";
  if (rawType === "3") return "Unknown Card (Type 3)";
  if (/^\d+$/.test(rawType)) return `Access Event (Type ${rawType})`;
  return rawType;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString();
}

function isHeartbeat(event) {
  const t = eventTypeOf(event);
  if (t.includes("statusupdate")) return true;
  if (String(event.result || "").toLowerCase() === "other" && !event.cardholder_id && !event.card_id) return true;
  return false;
}

function isAuthorizedAccess(event) {
  const result = String(event?.result || "").toLowerCase();
  const t = eventTypeOf(event);
  const denied = deniedCodeOf(event);
  if (denied && denied !== "0" && denied !== 0) return false;
  if (result === "granted" || result === "opened") return true;
  return t === "1" || /accessgranted|authorized|granted/.test(t);
}

function isUnknownAccess(event) {
  const result = String(event?.result || "").toLowerCase();
  if (result === "denied" || result === "unknown_card" || result === "forced" || result === "tamper") return true;
  const deniedCode = deniedCodeOf(event);
  if (deniedCode !== null && deniedCode !== "" && deniedCode !== "0" && deniedCode !== 0) return true;
  const t = eventTypeOf(event);
  return /^[2-9]$|^[1-9]\d+$/.test(t) || /unknowncard|denied|accessdenied/.test(t);
}

function eventCategory(event) {
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

function eventTypeOf(event) {
  return String(
    pick(event?.raw_payload || {}, "Type", "type", "EventType", "eventType") || event?.event_type || event?.reason || "",
  ).toLowerCase();
}

function deniedCodeOf(event) {
  return pick(event?.raw_payload || {}, "AccessDeniedCode", "accessDeniedCode");
}

function alertSignature(event, cardholderById, doorById) {
  const kind = isUnknownAccess(event) ? "unknown" : "authorized";
  const card = resolveCardLabel(event) || "-";
  const door = resolveDoorLabel(event, doorById) || event.door_id || "-";
  const holder = resolveCardholderLabel(event, cardholderById) || event.cardholder_id || "-";
  return `${kind}|${card}|${door}|${holder}`;
}

function pick(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && `${value}`.trim() !== "") return value;
  }
  return null;
}

function resolveDoorLabel(event, doorById) {
  const p = event.raw_payload || {};
  return (
    pick(p, "ReaderName", "readerName", "DoorName", "doorName") ||
    doorById?.[event.door_id]?.name ||
    doorById?.[event.door_ref]?.name ||
    null
  );
}

function resolveCardholderLabel(event, cardholderById) {
  const p = event.raw_payload || {};
  const first = pick(p, "CardholderFirstName", "cardholderFirstName", "FirstName", "firstName");
  const last = pick(p, "CardholderLastName", "cardholderLastName", "LastName", "lastName");
  const payloadName =
    [first, last].filter(Boolean).join(" ").trim() || pick(p, "CardholderName", "cardholderName", "Name", "name");
  if (payloadName) return payloadName;
  const mapped = cardholderById?.[event.cardholder_id] || cardholderById?.[event.cardholder_ref];
  if (mapped?.name) return mapped.name;
  if (mapped?.employee_id) return mapped.employee_id;
  return null;
}

function resolveCardLabel(event) {
  const p = event.raw_payload || {};
  return pick(p, "CardCode", "cardCode") || event.card_id || null;
}

function withId(label, id) {
  if (label && id) return `${label} (${shortId(id)})`;
  return label || id || "—";
}

function shortId(id) {
  if (!id) return "—";
  return String(id).length > 8 ? `${String(id).slice(0, 8)}…` : id;
}

function eventKey(event, idx) {
  const base =
    event.event_id ||
    event.id ||
    `${event.instance_id || "inst"}:${event.timestamp || "ts"}:${event.cardholder_id || "ch"}:${event.card_id || "card"}`;
  return `${base}:${idx}`;
}
