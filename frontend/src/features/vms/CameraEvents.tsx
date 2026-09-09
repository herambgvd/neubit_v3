"use client";

// VMS → EVENTS. The estate's device-event feed: normalized
// ONVIF/brand device events (motion|tamper|video_loss|io_input|line_crossing|
// zone_intrusion|audio|…) + system events, with filters (camera / type /
// severity / date / ack), LIVE updates over the core realtime SSE bridge
// (useVmsEventStream → prepend), an ack action, and a "jump to recording" that
// opens the PlaybackPlayer at the event time.
//
// Data source mirrors the access EventsFeed: an INITIAL history fetch via
// GET /vms/events (one request) + LIVE appends over SSE. Both are normalized to
// one shape and de-duped by event id so every renderer works across sources.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { EmptyState, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "@/features/workflow/api";
import { vms } from "./api";
import { useEstateCameras } from "./hooks/useEstateCameras";
import { EVENT_TYPE_FILTERS } from "./constants";
import { normalizeVmsEvent, eventKey, type NormalizedVmsEvent } from "./eventLib";
import { groupByDay } from "./eventGroups";
import { useVmsEventStream } from "./hooks/useVmsEventStream";
import type { EstateCamera, VmsEventPublic } from "./types";
import CameraEventRow from "./components/CameraEventRow";

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function CameraEventsPage() {
  const qc = useQueryClient();
  const [cameraId, setCameraId] = useState("");
  const [eventType, setEventType] = useState("");
  const [severity, setSeverity] = useState("");
  const [ack, setAck] = useState(""); // "" all | "false" unacked | "true" acked
  const [day, setDay] = useState("");
  const [live, setLive] = useState(true);

  // CAMERA ROSTER — THE WHOLE ESTATE, not this service's own rows.
  //
  // It read `/vms/cameras` alone. On a single-ownership estate that list is empty,
  // so the camera filter had nothing to offer and every row printed a raw uuid
  // where a camera name belongs — for events that all came from recorders.
  //
  // The events themselves are stored with the NODE-SIDE camera id (the event
  // supervisor mirrors each recorder's ledger under `raw.camera_id`), so both the
  // lookup and the filter's value must be that id, not the composite `fed:…` key
  // the wall uses for placement.
  const { cameras } = useEstateCameras();
  const cameraById = useMemo(() => {
    const m: Record<string, EstateCamera> = {};
    for (const c of cameras) {
      m[c.id] = c;
      const real = (c as { real_id?: string }).real_id;
      if (real) m[real] = c; // what an event actually carries
    }
    return m;
  }, [cameras]);
  const cameraName = (id: string | null | undefined): string | null => (id ? cameraById[id]?.name : null) || null;
  /** The id the events API filters on: node-side for a recorder-owned camera. */
  const eventCameraId = (c: EstateCamera): string => (c as { real_id?: string }).real_id || c.id;

  // The day filter → a [from,to) window (local day).
  const window = useMemo(() => {
    if (!day) return {};
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(from.getTime() + 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [day]);

  const listParams = useMemo(
    () => ({
      camera_id: cameraId || undefined,
      event_type: eventType || undefined,
      severity: severity || undefined,
      acknowledged: ack === "" ? undefined : ack === "true",
      from: window.from,
      to: window.to,
      limit: 200,
    }),
    [cameraId, eventType, severity, ack, window],
  );

  // Initial history — one fetch (no polling). Live updates arrive over SSE below.
  const q = useQuery({
    queryKey: ["vms-events", listParams],
    queryFn: () => vms.events.list(listParams),
    refetchOnWindowFocus: false,
  });

  // Live appends over the core realtime SSE bridge. Narrow to one camera when a
  // camera filter is set. Toggling `live` off closes the stream.
  const { events: liveEvents, connected } = useVmsEventStream({
    cameraId: cameraId || null,
    enabled: live,
  });

  const ackMut = useMutation({
    mutationFn: (id: string) => vms.events.ack(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms-events"] });
      toast.success("Event acknowledged");
    },
    onError: (e) => toast.error(apiError(e, "Failed to acknowledge")),
  });

  // Cross-link → Incidents. A camera event that fired an SOP created a workflow
  // Incident carrying that event's id in trigger_data.payload.event_id (surfaced as
  // `source_event_id`). Rather than N per-row calls, fetch recent camera-origin
  // incidents ONCE and match client-side by the camera-event id. `retry:false` so a
  // workflow outage just hides the badge instead of erroring the events feed.
  const linkedIncidentsQ = useQuery({
    queryKey: ["wf-incidents-by-camera-event"],
    queryFn: () => wfApi.instances.list({ source: "vision", limit: 500 }),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const incidentByEventId = useMemo(() => {
    const m = new Map<string, string>();
    for (const inc of linkedIncidentsQ.data ? asItems(linkedIncidentsQ.data) : []) {
      const key = inc.source_event_id;
      if (key && !m.has(key)) m.set(key, inc.instance_id);
    }
    return m;
  }, [linkedIncidentsQ.data]);

  // Merge live frames (newest-first) ahead of the fetched history, de-dupe by id,
  // and re-apply the active filters against the live-merged list so a live frame
  // that doesn't match the current filter isn't shown.
  const history = useMemo(() => {
    const rows: VmsEventPublic[] = q.data ? asItems(q.data) : [];
    return rows.map(normalizeVmsEvent).filter((e): e is NormalizedVmsEvent => !!e);
  }, [q.data]);
  const events = useMemo(() => {
    const seen = new Set<string>();
    const out: NormalizedVmsEvent[] = [];
    for (const raw of [...liveEvents, ...history]) {
      const e = normalizeVmsEvent(raw);
      if (!e) continue; // normalizeVmsEvent only returns null for a null input
      const key = e.id || e.event_id;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(e);
    }
    return out.filter((e) => {
      if (cameraId && e.camera_id !== cameraId) return false;
      if (eventType && e.event_type !== eventType) return false;
      if (severity && e.severity !== severity) return false;
      if (ack === "true" && !e.acknowledged) return false;
      if (ack === "false" && e.acknowledged) return false;
      if (window.from && e.occurred_at && e.occurred_at < window.from) return false;
      if (window.to && e.occurred_at && e.occurred_at >= window.to) return false;
      return true;
    });
  }, [liveEvents, history, cameraId, eventType, severity, ack, window]);

  const total = q.data?.total ?? events.length;

  // Severity breakdown + unacked count for the summary row (from the visible feed).
  const summary = useMemo(() => {
    const s = { critical: 0, warning: 0, info: 0, unacked: 0 };
    const isBucket = (k: string): k is keyof typeof s => Object.prototype.hasOwnProperty.call(s, k);
    for (const e of events) {
      if (isBucket(e.severity)) s[e.severity] += 1;
      if (!e.acknowledged) s.unacked += 1;
    }
    return s;
  }, [events]);

  const cameraOptions = [
    { value: "", label: "All cameras" },
    ...cameras.map((c) => ({ value: eventCameraId(c), label: c.name })),
  ];

  const groups = useMemo(() => groupByDay(events), [events]);
  const filtered = !!(cameraId || eventType || severity || ack || day);
  const clearAll = () => {
    setCameraId("");
    setEventType("");
    setSeverity("");
    setAck("");
    setDay("");
  };

  return (
    <div className="pb-8">
      {/* ── ONE CONTROL BAR ───────────────────────────────────────────────
          The live state, the counts an operator triages by, and the filters, on
          ONE row. They were two stacked cards — a strip of counts above a card of
          labelled dropdowns — which cost a fifth of the viewport before a single
          event was visible, on a screen whose whole job is the feed below it.

          The severity DROPDOWN is gone with them: the counts already filter by
          severity, and two controls for one thing means the one an operator did
          not touch silently contradicts the one they did. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-card-border bg-card px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="relative flex h-2.5 w-2.5">
            {live && connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                live ? (connected ? "bg-emerald-500" : "bg-amber-500") : "bg-muted"
              }`}
            />
          </span>
          <span className="text-[12px] font-semibold text-foreground">
            {!live ? "Paused" : connected ? "Live" : "Reconnecting…"}
          </span>
        </span>

        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          title={live ? "Stop appending new events" : "Append new events as they arrive"}
          aria-label={live ? "Pause the live feed" : "Resume the live feed"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon={live ? "heroicons-outline:pause" : "heroicons-outline:play"} className="text-xs" />
        </button>

        <span className="mx-0.5 h-5 w-px bg-card-border" aria-hidden />

        <CountChip label="All" value={events.length} active={!severity && ack !== "false"} onClick={() => { setSeverity(""); setAck(""); }} />
        <CountChip
          label="Critical"
          value={summary.critical}
          tone="bad"
          active={severity === "critical"}
          onClick={() => setSeverity(severity === "critical" ? "" : "critical")}
        />
        <CountChip
          label="Warning"
          value={summary.warning}
          tone="warn"
          active={severity === "warning"}
          onClick={() => setSeverity(severity === "warning" ? "" : "warning")}
        />
        <CountChip
          label="Info"
          value={summary.info}
          active={severity === "info"}
          onClick={() => setSeverity(severity === "info" ? "" : "info")}
        />
        <CountChip
          label="Unacked"
          value={summary.unacked}
          tone={summary.unacked ? "warn" : "ok"}
          active={ack === "false"}
          onClick={() => setAck(ack === "false" ? "" : "false")}
        />

        <span className="mx-0.5 h-5 w-px bg-card-border" aria-hidden />

        {/* The remaining filters, unlabelled: each one's placeholder already says
            what it narrows ("All cameras", "All types"), so a column of uppercase
            labels above them was a second row of chrome saying it again. The
            accessible name carries it for a screen reader. */}
        <div className="w-40">
          <Select
            ariaLabel="Filter by camera"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            options={cameraOptions}
            className="!mt-0 !h-8 !py-1"
          />
        </div>
        <div className="w-36">
          <Select
            ariaLabel="Filter by event type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            options={EVENT_TYPE_FILTERS}
            className="!mt-0 !h-8 !py-1"
          />
        </div>
        <input
          type="date"
          aria-label="Filter by day"
          value={day}
          max={todayStr()}
          onChange={(e) => setDay(e.target.value)}
          className="h-8 rounded-lg border border-field bg-transparent px-2 text-[12px] text-foreground outline-hidden focus:border-muted"
        />

        {filtered && (
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-xs" /> Clear
          </button>
        )}

        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: ["vms-events"] })}
          title="Re-read the history"
          aria-label="Refresh"
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-path" className="text-xs" />
        </button>
      </div>

      {/* ── Feed ── */}
      {q.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-card-border bg-card p-6 text-xs text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading events…
        </div>
      ) : q.isError ? (
        // A failed read must never look like a quiet estate — one is a reason to
        // relax, the other is a reason to look at the recorder.
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <Icon icon="heroicons-outline:exclamation-circle" className="mt-0.5 shrink-0 text-sm" />
          <div>
            <p className="font-medium">Could not load events</p>
            <p className="mt-0.5 text-[11px] opacity-80">{apiError(q.error, "Unknown error")}</p>
          </div>
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card">
          <EmptyState
            icon={filtered ? "heroicons-outline:funnel" : "heroicons-outline:bell-slash"}
            title={filtered ? "No events match these filters" : "No events yet"}
            subtitle={
              filtered
                ? "Widen the day, the camera or the severity — the feed itself is live."
                : "Events appear here the moment a recorder reports one — motion, tamper, video loss, I/O."
            }
            action={
              filtered ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
                >
                  <Icon icon="heroicons-outline:x-mark" className="text-xs" /> Clear filters
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        // Grouped by DAY, with the header sticky: scrolling a long feed without
        // one leaves an operator reading times with no date attached to them.
        <div className="space-y-3">
          {groups.map((g) => (
            <section key={g.key} className="overflow-hidden rounded-xl border border-card-border bg-card">
              <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-card-border bg-card/95 px-3 py-2 backdrop-blur-xs">
                <Icon icon="heroicons-outline:calendar-days" className="text-sm text-blue-500" />
                <span className="text-[12px] font-semibold text-foreground">{g.label}</span>
                <span className="rounded-sm bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {g.events.length}
                </span>
              </header>
              <div className="divide-y divide-card-border">
                {g.events.map((e, idx) => (
                  <CameraEventRow
                    key={eventKey(e, idx)}
                    event={e}
                    cameraName={cameraName(e.camera_id)}
                    incidentId={incidentByEventId.get(e.event_id || e.id || "") || null}
                    onAck={(ev) => {
                      if (ev.id) ackMut.mutate(ev.id);
                    }}
                    ackPending={ackMut.isPending && ackMut.variables === e.id}
                  />
                ))}
              </div>
            </section>
          ))}
          {total > events.length && (
            <p className="px-1 text-[11px] text-muted">
              Showing {events.length} of {total} — narrow the day or the camera to see further back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A count that FILTERS. The strip used to be four read-only tiles; a number an
 *  operator can see but not act on is decoration on a triage screen. */
function CountChip({
  label,
  value,
  tone = "info",
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "info" | "bad" | "warn" | "ok";
  active?: boolean;
  onClick: () => void;
}) {
  const toneCls =
    tone === "bad"
      ? "text-red-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "ok"
          ? "text-emerald-400"
          : "text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      title={active ? `Stop filtering by ${label}` : `Show only ${label}`}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
        active
          ? "border-blue-500/50 bg-blue-500/10 text-foreground"
          : "border-card-border text-muted hover:bg-hover hover:text-foreground"
      }`}
    >
      <span className={`font-mono text-[13px] tabular-nums ${toneCls}`}>{value}</span>
      {label}
    </button>
  );
}
