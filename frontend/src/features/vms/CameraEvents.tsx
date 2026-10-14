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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { EmptyState, Select } from "@/components/ui/kit";
import { HeaderSlot } from "@/components/shell/HeaderSlot";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { dropUrlParams, siteCameraKeys, siteNameFrom } from "@/features/core/sites/siteLinks";
import { workflow as wfApi } from "@/features/workflow/api";
import { vms } from "./api";
import { useAuth } from "@/lib/auth";
import { useEstateCameras } from "./hooks/useEstateCameras";
import { EVENT_TYPE_FILTERS, isAttentionSeverity } from "./constants";
import { normalizeVmsEvent, type NormalizedVmsEvent } from "./eventLib";
import { useVmsEventStream } from "./hooks/useVmsEventStream";
import type { EstateCamera, VmsEventPublic } from "./types";
import EventMonitorPane from "./components/EventMonitorPane";
import EventDetails from "./components/EventDetails";
import EventLivePane from "./components/EventLivePane";
import { AnprLinkedPane, useAnprRead } from "./components/AnprEvidence";
import { anprInvestigateHref, anprOf, matchesEventSearch } from "./anprLib";
import EventTable from "./components/EventTable";
import EscalateDialog from "./components/EscalateDialog";
import AlarmWindow from "./components/AlarmWindow";
import { clearAlarms, removeAlarm, type QueuedAlarm } from "./alarmQueue";
import { useAlarmPopupSettings } from "./hooks/useAlarmPopupSettings";

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Playback at an event — with the cameras bound to its ANPR camera, for a plate read. */
function investigateHrefOf(event: NormalizedVmsEvent | null | undefined): string | null {
  if (!event?.camera_id || !event.occurred_at) return null;
  const anpr = anprOf(event);
  return anpr
    ? anprInvestigateHref(event.camera_id, anpr, event.occurred_at)
    : `/playback?camera=${encodeURIComponent(event.camera_id)}&t=${encodeURIComponent(event.occurred_at)}`;
}

/** Whether an alarm brings a linked camera to show: a plate read whose recorder bound
 *  a camera to the ANPR camera. */
function hasLinkedCamera(event: NormalizedVmsEvent): boolean {
  return (anprOf(event)?.linkedCameraIds.length ?? 0) > 0;
}

/** A plate read's linked camera in the alarm window, at the read — the same pane as
 *  the page's third panel. The window sizes it. */
function AlarmLinkedPane({
  event,
  cameraById,
}: Readonly<{ event: NormalizedVmsEvent; cameraById: Record<string, EstateCamera> }>) {
  const anpr = anprOf(event);
  const read = useAnprRead(anpr).data;
  if (!anpr) return null;
  return (
    <AnprLinkedPane
      anpr={anpr}
      read={read}
      cameraById={cameraById}
      occurredAt={event.occurred_at}
      investigateHref={investigateHrefOf(event)}
    />
  );
}

/** What the feed indicator says and what colour it says it in.
 *
 *  The dot and the words were two chains reading the same two flags in opposite
 *  order, which is one edit away from a green dot next to "Reconnecting…". They
 *  answer one question, so they are decided in one place.
 *
 *  Paused is deliberately its own state rather than a shade of disconnected: the
 *  operator stopped the feed, so amber "reconnecting" would be this console
 *  reporting a fault it invented. */
export function feedVerdict(live: boolean, connected: boolean): { dot: string; text: string } {
  if (!live) return { dot: "bg-muted", text: "Feed paused" };
  if (!connected) return { dot: "bg-amber-500", text: "Reconnecting…" };
  return { dot: "bg-emerald-500", text: "Live feed" };
}

/** How long one read of the event history may take before it counts as lost. */
const EVENTS_TIMEOUT_MS = 12_000;

/** The axios code of a read that got no answer at all (timed out, or no network). */
function lostCode(err: unknown): string | null {
  const e = err as { code?: string; response?: unknown } | null;
  if (!e || e.response) return null;
  return e.code === "ECONNABORTED" || e.code === "ETIMEDOUT" || e.code === "ERR_NETWORK" ? e.code : null;
}

/** Why the history could not be read, in words that say what to check. */
function eventsLoadError(err: unknown): string {
  const code = lostCode(err);
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return `The server did not answer within ${EVENTS_TIMEOUT_MS / 1000} s. Check the network connection to the server, then try again.`;
  }
  if (code === "ERR_NETWORK") return "The server cannot be reached. Check the network connection, then try again.";
  return apiError(err, "Unknown error");
}

export default function CameraEventsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [cameraId, setCameraId] = useState("");
  const [eventType, setEventType] = useState("");
  const [severity, setSeverity] = useState("");
  // `?site=<id>&ack=false` is the estate map's Alarms count, opened (SCRUM-311).
  const params = useSearchParams();
  const [ack, setAck] = useState(() => params?.get("ack") ?? ""); // "" all | "false" unacked | "true" acked
  const [siteId, setSiteId] = useState<string | null>(() => params?.get("site") ?? null);
  const [day, setDay] = useState("");
  // Free text on the title (a plate, a camera name): typed into the box, applied a
  // moment after the operator stops typing so each key is not a query.
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 350);
    return () => clearTimeout(t);
  }, [searchText]);
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
  // The cameras placed at the site filter, under both ids an event may carry.
  const placementsQ = useQuery({
    queryKey: ["device-placements-index"],
    queryFn: () => sitesApi.devicePlacements.index(),
    enabled: !!siteId,
    staleTime: 30_000,
  });
  const placements = useMemo(() => placementsQ.data?.items ?? [], [placementsQ.data]);
  const siteKeys = useMemo(() => (siteId ? siteCameraKeys(placements, siteId) : null), [placements, siteId]);
  const siteName = siteId ? siteNameFrom(placements, siteId) ?? "this site" : null;
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
      q: search || undefined,
      limit: 200,
    }),
    [cameraId, eventType, severity, ack, window, search],
  );

  // Initial history — one fetch (no polling). Live updates arrive over SSE below.
  // A changed filter keeps the last rows up (marked Updating) until the new ones
  // land; a read the network swallowed times out and is tried once more, then the
  // table says so with a retry, never an endless spinner (SCRUM-325).
  const q = useQuery({
    queryKey: ["vms-events", listParams],
    queryFn: ({ signal }) => vms.events.list(listParams, { signal, timeout: EVENTS_TIMEOUT_MS }),
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    // Once more only when the server never answered; an answer, even an error, is
    // the answer.
    retry: (failures, err) => failures < 1 && !!lostCode(err),
  });

  // Live appends over the core realtime SSE bridge. Narrow to one camera when a
  // camera filter is set. Toggling `live` off closes the stream.
  const { events: liveEvents, connected } = useVmsEventStream({
    cameraId: cameraId || null,
    enabled: live,
  });
  const feed = feedVerdict(live, connected);

  const ackMut = useMutation({
    mutationFn: (id: string) => vms.events.ack(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms-events"] });
      toast.success("Event acknowledged");
    },
    onError: (e) => toast.error(apiError(e, "Failed to acknowledge")),
  });

  // ESCALATION — the door from the ledger to the work. An event an operator
  // decides needs following up becomes an incident running a procedure, and this
  // page holds only the choice of WHICH event; the dialog holds the rest.
  const [escalating, setEscalating] = useState<NormalizedVmsEvent[] | null>(null);
  const canEscalate = can("workflow.instance.create");

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
      // A BURST alarm claims every event it was raised from. Without this the
      // other twenty-eight still offer "Escalate" and a second alarm gets raised
      // for the thing somebody already took.
      const ids = (inc.trigger_data?.payload as { event_ids?: unknown } | undefined)?.event_ids;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string" && !m.has(id)) m.set(id, inc.instance_id);
        }
      }
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
    // An event is at the filtered site when its camera is one placed there.
    const atSite = (id: string | null | undefined) => !siteKeys || (!!id && siteKeys.has(id));
    // "" is every event; otherwise the flag has to match the filter's word.
    const ackMatches = (acked: boolean) => ack === "" || String(acked) === ack;
    return out.filter((e) => {
      if (cameraId && e.camera_id !== cameraId) return false;
      if (!atSite(e.camera_id)) return false;
      if (eventType && e.event_type !== eventType) return false;
      if (severity && e.severity !== severity) return false;
      if (!ackMatches(!!e.acknowledged)) return false;
      if (window.from && e.occurred_at && e.occurred_at < window.from) return false;
      if (window.to && e.occurred_at && e.occurred_at >= window.to) return false;
      return matchesEventSearch(e.title, search);
    });
  }, [liveEvents, history, cameraId, siteKeys, eventType, severity, ack, window, search]);

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

  // The alarm pop-up links here with ?event=<id> — from another page, or from the
  // pop-up on this one ("Show in panes", SCRUM-327): the operator picked ONE
  // event, so that is the one the canvas opens on, whenever the link changes.
  const askedEvent = params?.get("event") ?? null;
  useEffect(() => {
    if (!askedEvent) return;
    setSelectedId(askedEvent);
    setDismissed(false);
    setFollow(false); // they asked for this one; do not yank it away
  }, [askedEvent]);

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
  const filtered = !!(cameraId || siteId || eventType || severity || ack || day || search);
  const clearSite = () => {
    setSiteId(null);
    dropUrlParams("site", "ack");
  };
  const clearAll = () => {
    if (siteId) clearSite();
    setCameraId("");
    setEventType("");
    setSeverity("");
    setAck("");
    setDay("");
    setSearchText("");
    setSearch("");
  };
  // "Every read of this plate": the plate's reads across every ANPR camera and the
  // whole history, with nothing else narrowing it.
  const findPlate = (plate: string) => {
    clearAll();
    setEventType("anpr");
    setSearchText(plate);
    setSearch(plate);
  };

  // The selected event as a plate read, and the recorder's record of it (shared with
  // the panes, one query per read).
  const selectedAnpr = anprOf(selected);
  const selectedRead = useAnprRead(selectedAnpr).data;
  const investigateHref = investigateHrefOf(selected);

  // THE ALARM WINDOW (SCRUM-327): a new alarm opens in the middle of this page,
  // large, with this page's own monitor and details panes for it — the window
  // HikCentral and DSS open on their monitoring screens. Its actions are this
  // page's: acknowledging or escalating takes the alarm out of the window, and
  // "Show in panes" closes it on that alarm in the panes.
  const popup = useAlarmPopupSettings();
  const showInPanes = (key: string) => {
    setSelectedId(key);
    setDismissed(false);
    setFollow(false); // they picked this one; do not yank it away
  };
  const alarmMedia = (a: QueuedAlarm) => (
    <EventMonitorPane event={a.event} camera={a.event.camera_id ? cameraById[a.event.camera_id] ?? null : null} />
  );
  const alarmDetails = (a: QueuedAlarm) => {
    const cam = a.event.camera_id ? cameraById[a.event.camera_id] : undefined;
    return (
      <EventDetails
        event={a.event}
        cameraName={cameraName(a.event.camera_id) ?? a.cameraName}
        recorderName={(cam as { node_name?: string } | undefined)?.node_name ?? a.recorderName}
        incidentId={incidentByEventId.get(a.event.event_id || a.event.id || "") || null}
        onAck={(ev) => {
          removeAlarm(a.key);
          if (ev.id) ackMut.mutate(ev.id);
        }}
        ackPending={ackMut.isPending && !!a.event.id && ackMut.variables === a.event.id}
        investigateHref={investigateHrefOf(a.event)}
        onFindPlate={(plate) => {
          clearAlarms();
          findPlate(plate);
        }}
        onEscalate={
          canEscalate
            ? () => {
                removeAlarm(a.key);
                setEscalating([a.event]);
              }
            : undefined
        }
      />
    );
  };

  // What the table says where its rows go. The rows of the last filter are still in
  // the cache while the new read is on its way, and the client filter may empty them:
  // that is "loading", not "no events match".
  let tableStatus: ReactNode = null;
  if (q.isError) {
    // A failed read must never look like a quiet estate — one is a reason to
    // relax, the other is a reason to look at the recorder.
    tableStatus = (
      <div role="alert" className="flex max-w-md flex-col items-center gap-2 text-center">
        <Icon icon="heroicons-outline:exclamation-circle" className="text-2xl text-red-400" />
        <p className="text-[12.5px] font-medium text-foreground">Could not load events</p>
        <p className="text-[11px] text-muted">{eventsLoadError(q.error)}</p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-path" className="text-xs" /> Try again
        </button>
      </div>
    );
  } else if (q.isLoading || (q.isPlaceholderData && events.length === 0)) {
    tableStatus = (
      <output className="flex flex-col items-center gap-2 text-center text-[12px] text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-xl" />
        <span>{q.failureCount > 0 ? "The server did not answer — trying once more…" : "Loading events…"}</span>
      </output>
    );
  } else if (events.length === 0) {
    tableStatus = (
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
    );
  }

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
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${feed.dot}`} />
          </span>
          <span className="text-[12px] font-semibold text-foreground">{feed.text}</span>
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
            investigateHref={investigateHref}
            onFindPlate={findPlate}
            onEscalate={canEscalate ? () => setEscalating([selected]) : undefined}
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
        {/* A plate read's third pane is the camera its recorder bound to the ANPR
            camera, at the read — the context camera every ANPR console puts beside
            the plate. Without one bound, live of the ANPR camera, as for any event. */}
        {selectedAnpr && selectedAnpr.linkedCameraIds.length > 0 ? (
          <AnprLinkedPane
            key={selectedAnpr.readId || selected?.id}
            anpr={selectedAnpr}
            read={selectedRead}
            cameraById={cameraById}
            occurredAt={selected?.occurred_at}
            investigateHref={investigateHref}
          />
        ) : (
          <EventLivePane camera={monitorCamera} />
        )}
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
          {canEscalate && (
            // ONE ALARM FOR A BURST. Twenty-nine motions from one camera are one
            // thing that happened; twenty-nine alarms is a queue nobody reads.
            <button
              type="button"
              onClick={() => {
                const picked = events.filter((e) => checkedKeys.has(e.event_id || e.id || ""));
                if (picked.length) setEscalating(picked);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 px-2.5 py-1 text-[11.5px] text-orange-300 transition hover:bg-orange-500/20"
            >
              <Icon icon="heroicons-outline:arrow-trending-up" className="text-xs" /> Escalate as one alarm
            </button>
          )}
          <button
            type="button"
            onClick={() => setCheckedKeys(new Set())}
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-[11.5px] text-muted transition hover:text-foreground"
          >
            Clear
          </button>
        </div>
      )}

      {/* min-h-0 flex-1: the table takes whatever the evidence row left and
          scrolls its ROWS inside that, so the toolbar and the paging stay put —
          through loading, a failed read and an empty feed too. */}
      <div className="min-h-0 flex-1">
        <EventTable
          status={tableStatus}
          busy={q.isFetching && q.isPlaceholderData && !tableStatus}
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
              {siteId && (
                <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-nb-blue/40 bg-nb-blue/10 px-2 text-[11.5px] text-nb-blueb">
                  <Icon icon="heroicons-outline:building-office-2" className="text-[12px]" />
                  Site: {siteName}
                  <button
                    type="button"
                    aria-label="Show events from every site"
                    title="Show events from every site"
                    onClick={clearSite}
                    className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-nb-blue/20"
                  >
                    <Icon icon="heroicons-outline:x-mark" className="text-[12px]" />
                  </button>
                </span>
              )}
              <label className="relative">
                <Icon
                  icon="heroicons-outline:magnifying-glass"
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted"
                />
                <input
                  type="search"
                  aria-label="Search events by plate or title"
                  placeholder="Plate or title"
                  value={searchText}
                  maxLength={64}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="h-8 w-40 rounded-lg border border-field bg-transparent pl-7 pr-2 text-[12px] text-foreground outline-hidden placeholder:text-muted focus:border-muted"
                />
              </label>
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
                <span>Rows</span>
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

      {popup.prefs.popup && popup.prefs.popupOnEvents && (
        <AlarmWindow
          closeAfterMs={popup.closeAfterMs}
          criticalStays={popup.criticalStays}
          sound={popup.sound}
          onMute={popup.mute}
          onShowInPanes={(a) => {
            clearAlarms();
            showInPanes(a.key);
          }}
          renderMedia={alarmMedia}
          renderDetails={alarmDetails}
          renderExtra={(a) =>
            hasLinkedCamera(a.event) ? <AlarmLinkedPane event={a.event} cameraById={cameraById} /> : null
          }
        />
      )}

      {escalating && (
        <EscalateDialog
          open
          events={escalating}
          cameraName={cameraName(escalating[0].camera_id)}
          recorderName={
            (cameraById[escalating[0].camera_id || ""] as { node_name?: string } | undefined)?.node_name ?? null
          }
          nodeId={
            (cameraById[escalating[0].camera_id || ""] as { node_id?: string } | undefined)?.node_id ?? null
          }
          onClose={() => setEscalating(null)}
          onCreated={() => {
            // Escalating IS taking it: events somebody is now working must not
            // keep sitting in the count of what nobody has touched. Every event in
            // the burst, not only the one the alarm is anchored to.
            for (const e of escalating) {
              if (e.id && !e.acknowledged) ackMut.mutate(e.id);
            }
            setCheckedKeys(new Set());
          }}
        />
      )}
    </div>
  );
}

/** A count that FILTERS. The strip used to be four read-only tiles; a number an
 *  operator can see but not act on is decoration on a triage screen. */
const COUNT_TONES: Record<string, string> = {
  bad: "text-red-400",
  warn: "text-amber-400",
  ok: "text-emerald-400",
  info: "text-foreground",
};

function CountChip({
  label,
  value,
  tone = "info",
  active,
  onClick,
}: Readonly<{
  label: string;
  value: number;
  tone?: "info" | "bad" | "warn" | "ok";
  active?: boolean;
  onClick: () => void;
}>) {
  const toneCls = COUNT_TONES[tone] ?? COUNT_TONES.info;
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
