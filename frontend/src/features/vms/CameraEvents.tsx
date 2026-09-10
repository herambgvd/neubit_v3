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
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { EmptyState, Select } from "@/components/ui/kit";
import { HeaderSlot } from "@/components/shell/HeaderSlot";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "@/features/workflow/api";
import { vms } from "./api";
import { useEstateCameras } from "./hooks/useEstateCameras";
import { EVENT_TYPE_FILTERS, isAttentionSeverity } from "./constants";
import { normalizeVmsEvent, type NormalizedVmsEvent } from "./eventLib";
import { useVmsEventStream } from "./hooks/useVmsEventStream";
import type { EstateCamera, VmsEventPublic } from "./types";
import EventMonitorPane from "./components/EventMonitorPane";
import EventDetails from "./components/EventDetails";
import EventLivePane from "./components/EventLivePane";
import EventTable from "./components/EventTable";

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
    const s = { critical: 0, alarm: 0, warning: 0, info: 0, unacked: 0 };
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

  // ONE TABLE, PAGED. It was a table per day — three headers on a screen showing
  // seventeen rows, and "everything on Channel 5" read in pieces. The date now
  // rides on every row, and the page size is the operator's.
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  const pageRows = events.slice(page * pageSize, page * pageSize + pageSize);
  // ── "N new ↑" ─────────────────────────────────────────────────────────────
  //
  // A live feed that prepends while an operator is reading row forty moves the
  // thing they were reading. So arrivals are COUNTED while they are away from the
  // top (scrolled down, or paused), and the count is a button that takes them
  // back. Nothing is hidden — the rows are already in the list; this only says
  // that the top has changed.
  const [pending, setPending] = useState(0);
  const [atTop, setAtTop] = useState(true);
  const topKey = useRef<string | null>(null);

  // The ROWS scroll, not the page: "at the top" is the table's own scrollTop.
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const onRowsScroll = () => setAtTop((rowsRef.current?.scrollTop ?? 0) < 120);

  useEffect(() => {
    const newestKey = events[0]?.event_id || events[0]?.id || null;
    if (!newestKey) return;
    if (topKey.current === null) {
      topKey.current = newestKey; // first load is not "new"
      return;
    }
    if (topKey.current === newestKey) return;
    if (atTop && live) {
      // They are looking at the top: the row is simply there, no announcement.
      topKey.current = newestKey;
      return;
    }
    // Count the arrivals they have not been shown, by position of the last seen.
    const seenAt = events.findIndex((e) => (e.event_id || e.id) === topKey.current);
    setPending(seenAt > 0 ? seenAt : (p) => p + 1);
  }, [events, atTop, live]);

  // ── Bulk selection ────────────────────────────────────────────────────────
  // Twenty-nine of the fifty-nine events on this estate are motion from one
  // camera. Acknowledging a burst one row at a time is the work the console
  // should be doing.
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(() => new Set());

  const toggleChecked = (key: string) =>
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAllIn = (group: NormalizedVmsEvent[]) =>
    setCheckedKeys((prev) => {
      const keys = group.map((e) => e.event_id || e.id || "").filter(Boolean);
      const all = keys.every((k) => prev.has(k));
      const next = new Set(prev);
      keys.forEach((k) => (all ? next.delete(k) : next.add(k)));
      return next;
    });

  const ackSelected = () => {
    // Only what is actually unacknowledged: re-acking is a no-op on the server,
    // but sending it is still a request per row for nothing.
    for (const key of checkedKeys) {
      const e = eventById.get(key);
      if (e && !e.acknowledged && e.id) ackMut.mutate(e.id);
    }
    setCheckedKeys(new Set());
  };

  // A filter that shrinks the list must not leave the operator on page four of
  // one page — nothing would render and the table would look empty.
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(0, Math.ceil(events.length / pageSize) - 1)));
  }, [events.length, pageSize]);

  const goToNewest = () => {
    topKey.current = events[0]?.event_id || events[0]?.id || null;
    setPending(0);
    setPage(0);
    setAtTop(true);
    rowsRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  // ── THE MONITORING HALF ───────────────────────────────────────────────────
  //
  // An alarm list beside a canvas that switches to the alarm's camera is what
  // every enterprise VMS does with this screen, and the reason is not decoration:
  // the operator is HERE to look, so the console shows the picture rather than
  // telling them a picture exists somewhere else.
  //
  // `follow` is what makes it a monitoring surface rather than a list with a
  // viewer attached — a new alarm takes the canvas. It only ever follows an
  // ATTENTION severity: a canvas that jumps to a heartbeat gets switched off, and
  // then it is not there for the alarm either.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  // NOTHING SELECTED IS A STATE AN OPERATOR CAN REACH. The triptych opens on an
  // event they did not choose — the newest one, or an alarm that took the canvas
  // — so without this the only way off an event is onto another one, and a
  // console that cannot be put down keeps showing a camera at whoever walks past.
  const [dismissed, setDismissed] = useState(false);
  const followed = useRef<string | null>(null);

  // Not hand-memoized: the compiler could not preserve a useMemo here (the Map is
  // built by mutation), and a manual memo it has to skip costs the whole
  // component its optimisation. Building a Map over at most a few hundred rows is
  // not the expense; the skipped compilation would be.
  const eventById = ((): Map<string, NormalizedVmsEvent> => {
    const m = new Map<string, NormalizedVmsEvent>();
    for (const e of events) {
      const k = e.event_id || e.id;
      if (k) m.set(k, e);
    }
    return m;
  })();

  // The toast off this page links here with ?event=<id>: the operator clicked a
  // notification about ONE event, so that is the one the canvas opens on.
  useEffect(() => {
    // `globalThis`, not `window`: this component already binds a local `window`
    // for the day range, and the shadow makes the global unreachable here.
    if (typeof globalThis === "undefined" || !globalThis.location) return;
    const asked = new URLSearchParams(globalThis.location.search).get("event");
    if (asked) {
      setSelectedId(asked);
      setFollow(false); // they asked for this one; do not yank it away
    }
  }, []);

  // Auto-follow: the newest attention event takes the canvas, once. `followed`
  // remembers which one so an operator who clicks another row keeps it until a
  // NEWER alarm arrives.
  useEffect(() => {
    if (!follow || dismissed) return;
    const newest = events.find((e) => isAttentionSeverity(e.severity));
    const key = newest?.event_id || newest?.id;
    if (!key || followed.current === key) return;
    followed.current = key;
    setSelectedId(key);
  }, [events, follow, dismissed]);

  const selected = useMemo(() => {
    if (dismissed) return null;
    if (selectedId && eventById.has(selectedId)) return eventById.get(selectedId) ?? null;
    // Nothing chosen yet: the newest event, so the pane is never blank while the
    // feed has something in it.
    return events[0] ?? null;
  }, [dismissed, selectedId, eventById, events]);

  /** The camera an event names, as the ESTATE knows it — the recorder that owns
   *  it and the id it answers to there. The event carries the node-side id; the
   *  estate list is keyed by both that and the composite `fed:` key, so this
   *  resolves either way. Without a match there is no session to mint, live or
   *  recorded, and the pane says so rather than guessing. */
  const monitorCamera = useMemo(
    () => (selected?.camera_id ? cameraById[selected.camera_id] ?? null : null),
    [selected, cameraById],
  );
  const filtered = !!(cameraId || eventType || severity || ack || day);
  const clearAll = () => {
    setCameraId("");
    setEventType("");
    setSeverity("");
    setAck("");
    setDay("");
  };

  return (
    // A COLUMN THAT FILLS THE PANE. Nothing on this screen scrolls except the
    // rows: an operator watching the selected event's recording should never have
    // to scroll the video off the top to reach the list, and scrolling back is
    // time in the one place there is none.
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── IN THE TOP BAR ──────────────────────────────────────────────────
          The live state and the severity counts ride in the GLOBAL HEADER, beside
          the "Events" badge — the same place the section names itself. They were a
          row on the page, and a row on the page is a row of evidence lost. The
          FILTERS live in the table's toolbar, with the rows they narrow. */}
      <HeaderSlot>
      <div className="flex flex-wrap items-center gap-1.5">
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
            {!live ? "Feed paused" : connected ? "Live feed" : "Reconnecting…"}
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
        <CountChip label="Critical" value={summary.critical} tone="bad" active={severity === "critical"} onClick={() => setSeverity(severity === "critical" ? "" : "critical")} />
        <CountChip label="Alarm" value={summary.alarm} tone="warn" active={severity === "alarm"} onClick={() => setSeverity(severity === "alarm" ? "" : "alarm")} />
        <CountChip label="Warning" value={summary.warning} tone="warn" active={severity === "warning"} onClick={() => setSeverity(severity === "warning" ? "" : "warning")} />
        <CountChip label="Info" value={summary.info} active={severity === "info"} onClick={() => setSeverity(severity === "info" ? "" : "info")} />
        <CountChip label="Unacked" value={summary.unacked} tone={summary.unacked ? "warn" : "ok"} active={ack === "false"} onClick={() => setAck(ack === "false" ? "" : "false")} />

        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: ["vms-events"] })}
          title="Re-read the history"
          aria-label="Refresh"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-path" className="text-xs" />
        </button>
      </div>
      </HeaderSlot>

      {pending > 0 && (
        // Fixed, not in the flow: it must be reachable from row forty, which is
        // where an operator is when this matters.
        <button
          type="button"
          onClick={goToNewest}
          className="fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-full border border-blue-500/50 bg-blue-500/15 px-3 py-1.5 text-[12px] font-medium text-blue-200 shadow-lg backdrop-blur-xs transition hover:bg-blue-500/25"
        >
          <Icon icon="heroicons-outline:arrow-up" className="mr-1 inline text-xs" />
          {pending} new event{pending === 1 ? "" : "s"}
        </button>
      )}

      {/* ── EVIDENCE ABOVE, LIST BELOW ─────────────────────────────────────
          The shape every alarm console converges on: the selected event's
          RECORDING, its FACTS, and what is happening on that camera NOW, across
          the top; the list underneath, dense enough to scan a shift in.

          The third panel is live rather than a still. A recorder keeps no
          snapshot of a past instant, so a "Snapshot" pane could only ever show a
          frame from some other moment and label it as this one. Live answers a
          question an operator actually has — is it still going on — and says so
          when the camera is the thing that broke. */}
      {/* A FIXED ROW HEIGHT, and the reason is the screenshot: Details has a dozen
          fields, the grid stretched to fit them, and the two video panels beside it
          were stretched to match — a 16:9 player in a 24rem-tall cell letterboxes
          into a black band. The row is bounded now and Details scrolls inside its
          own card, so the players keep their aspect ratio and the table comes up
          the screen. */}
      <div className="grid shrink-0 grid-cols-1 gap-3 [&>*]:min-h-[15rem] lg:h-[19rem] lg:grid-cols-3 lg:[&>*]:min-h-0">
        <EventMonitorPane
          event={selected}
          camera={monitorCamera}
          follow={follow}
          onFollowChange={(on) => {
            setFollow(on);
            if (on) setDismissed(false); // asking to follow alarms is asking to be shown one
          }}
        />
        {selected ? (
          <EventDetails
            event={selected}
            cameraName={cameraName(selected.camera_id)}
            recorderName={(monitorCamera as { node_name?: string } | null)?.node_name ?? null}
            incidentId={incidentByEventId.get(selected.event_id || selected.id || "") || null}
            onAck={(ev) => {
              if (ev.id) ackMut.mutate(ev.id);
            }}
            ackPending={ackMut.isPending && !!selected.id && ackMut.variables === selected.id}
            investigateHref={
              selected.camera_id && selected.occurred_at
                ? `/playback?camera=${encodeURIComponent(selected.camera_id)}&t=${encodeURIComponent(selected.occurred_at)}`
                : null
            }
            onClose={() => {
              setDismissed(true);
              setSelectedId(null);
              setFollow(false); // or the next alarm would put it straight back
            }}
          />
        ) : (
          // The same card as the other two, not a bare box: three panels that
          // keep their shape while empty read as a console waiting, rather than as
          // a screen half-loaded.
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
            <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
              <Icon icon="heroicons-outline:information-circle" className="text-sm text-blue-500" />
              <span className="text-[12px] font-semibold text-foreground">Details</span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <Icon icon="heroicons-outline:cursor-arrow-rays" className="text-3xl text-muted opacity-40" />
              <p className="text-[12.5px] text-foreground">Pick an event</p>
              <p className="max-w-xs text-[11px] text-muted">
                Its facts land here — what fired, how bad, which camera, and whether
                anyone has taken it.
              </p>
            </div>
          </div>
        )}
        <EventLivePane camera={monitorCamera} />
      </div>

      {/* Bulk actions appear only when there is a selection — a burst of motion
          from one camera is acknowledged in one action, not twenty-nine. */}
      {checkedKeys.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/10 px-3 py-2">
          <span className="text-[12px] text-blue-200">
            {checkedKeys.size} selected
          </span>
          <button
            type="button"
            onClick={ackSelected}
            disabled={ackMut.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            <Icon icon="heroicons-outline:check" className="text-xs" /> Acknowledge selected
          </button>
          <button
            type="button"
            onClick={() => setCheckedKeys(new Set())}
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-[11.5px] text-muted transition hover:text-foreground"
          >
            Clear
          </button>
        </div>
      )}

      {q.isLoading ? (
        <div className="flex min-h-0 flex-1 items-center gap-2 rounded-xl border border-card-border bg-card p-6 text-xs text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading events…
        </div>
      ) : q.isError ? (
        // A failed read must never look like a quiet estate — one is a reason to
        // relax, the other is a reason to look at the recorder.
        <div className="flex min-h-0 flex-1 items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <Icon icon="heroicons-outline:exclamation-circle" className="mt-0.5 shrink-0 text-sm" />
          <div>
            <p className="font-medium">Could not load events</p>
            <p className="mt-0.5 text-[11px] opacity-80">{apiError(q.error, "Unknown error")}</p>
          </div>
        </div>
      ) : events.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center rounded-xl border border-card-border bg-card">
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
        // min-h-0 flex-1: the table takes whatever the evidence row left and
        // scrolls its ROWS inside that, so the toolbar and the paging stay put.
        <div className="min-h-0 flex-1">
        <EventTable
          scrollRef={rowsRef}
          onScroll={onRowsScroll}
          events={pageRows}
          selectedId={selected?.event_id || selected?.id || null}
          onSelect={(e) => {
            setSelectedId(e.event_id || e.id || null);
            setDismissed(false);
            setFollow(false);
          }}
          checked={checkedKeys}
          onToggleChecked={toggleChecked}
          onToggleAll={() => toggleAllIn(pageRows)}
          cameraName={cameraName}
          toolbar={
            <>
              <div className="w-44">
                <Select
                  ariaLabel="Filter by camera"
                  value={cameraId}
                  onChange={(e) => setCameraId(e.target.value)}
                  options={cameraOptions}
                  className="!mt-0 !h-8 !py-1"
                />
              </div>
              <div className="w-40">
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
            </>
          }
          paging={
            <>
              <span className="font-mono text-[11px] text-muted">
                {events.length === 0
                  ? "0"
                  : `${page * pageSize + 1}–${Math.min(events.length, (page + 1) * pageSize)} of ${events.length}`}
                {total > events.length && ` (of ${total} on the recorder)`}
              </span>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                Rows
                <select
                  aria-label="Rows per page"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(0);
                  }}
                  className="h-7 rounded-md border border-field bg-transparent px-1.5 text-[11px] text-foreground outline-hidden"
                >
                  {[25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <span className="inline-flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-40"
                >
                  <Icon icon="heroicons-mini:chevron-left" className="text-xs" />
                </button>
                <span className="px-1 font-mono text-[11px] text-muted">
                  {page + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-40"
                >
                  <Icon icon="heroicons-mini:chevron-right" className="text-xs" />
                </button>
              </span>
            </>
          }
        />
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
