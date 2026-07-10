"use client";

// VMS → Camera events (P5-C). The camera device-events surface: normalized
// ONVIF/brand device events (motion|tamper|video_loss|io_input|line_crossing|
// zone_intrusion|audio|…) + system events, with filters (camera / type /
// severity / date / ack), LIVE updates over the core realtime SSE bridge
// (useVmsEventStream → prepend), an ack action, and a "jump to recording" that
// opens the PlaybackPlayer at the event time.
//
// Data source mirrors the access EventsFeed: an INITIAL history fetch via
// GET /vms/events (one request) + LIVE appends over SSE. Both are normalized to
// one shape and de-duped by event id so every renderer works across sources.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { PageHeader, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "@/features/workflow/api";
import { vms } from "./api";
import { EVENT_TYPE_FILTERS, SEVERITY_FILTERS } from "./constants";
import { normalizeVmsEvent, eventKey } from "./eventLib";
import { useVmsEventStream } from "./hooks/useVmsEventStream";
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

  // Camera roster (filter dropdown + name lookup).
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "events-picker"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const cameraById = useMemo(
    () => Object.fromEntries(cameras.map((c) => [c.id, c])),
    [cameras],
  );
  const cameraName = (id) => cameraById[id]?.name || null;

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
    mutationFn: (id) => vms.events.ack(id),
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
    const m = new Map();
    for (const inc of asItems(linkedIncidentsQ.data)) {
      const key = inc.source_event_id;
      if (key && !m.has(key)) m.set(key, inc.instance_id ?? inc.id);
    }
    return m;
  }, [linkedIncidentsQ.data]);

  // Merge live frames (newest-first) ahead of the fetched history, de-dupe by id,
  // and re-apply the active filters against the live-merged list so a live frame
  // that doesn't match the current filter isn't shown.
  const history = useMemo(() => asItems(q.data).map(normalizeVmsEvent), [q.data]);
  const events = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const raw of [...liveEvents, ...history]) {
      const e = normalizeVmsEvent(raw);
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

  const cameraOptions = [
    { value: "", label: "All cameras" },
    ...cameras.map((c) => ({ value: c.id, label: c.name })),
  ];
  const ackOptions = [
    { value: "", label: "All" },
    { value: "false", label: "Unacknowledged" },
    { value: "true", label: "Acknowledged" },
  ];

  return (
    <div className="pb-8">
      <PageHeader
        title="Camera events"
        subtitle="Device-level camera events — motion, tamper, video-loss, I/O, line/zone, and system alerts."
        actions={
          <span className="inline-flex items-center gap-1.5 text-[11px]">
            <span className={`h-2 w-2 rounded-full ${live ? (connected ? "bg-emerald-500" : "bg-amber-500") : "bg-muted"}`} />
            <span className="text-muted">{!live ? "Live off" : connected ? "Live" : "Reconnecting…"}</span>
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              className="ml-1 inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground"
            >
              <Icon icon={live ? "heroicons-outline:pause" : "heroicons-outline:play"} className="text-xs" />
              {live ? "Pause" : "Resume"}
            </button>
          </span>
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-card-border bg-card p-3">
        <FilterField label="Camera">
          <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)} options={cameraOptions} className="!h-9 !py-1.5" />
        </FilterField>
        <FilterField label="Type">
          <Select value={eventType} onChange={(e) => setEventType(e.target.value)} options={EVENT_TYPE_FILTERS} className="!h-9 !py-1.5" />
        </FilterField>
        <FilterField label="Severity">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)} options={SEVERITY_FILTERS} className="!h-9 !py-1.5" />
        </FilterField>
        <FilterField label="Status">
          <Select value={ack} onChange={(e) => setAck(e.target.value)} options={ackOptions} className="!h-9 !py-1.5" />
        </FilterField>
        <FilterField label="Day">
          <input
            type="date"
            value={day}
            max={todayStr()}
            onChange={(e) => setDay(e.target.value)}
            className="h-9 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted"
          />
        </FilterField>
        {(cameraId || eventType || severity || ack || day) && (
          <button
            type="button"
            onClick={() => {
              setCameraId("");
              setEventType("");
              setSeverity("");
              setAck("");
              setDay("");
            }}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-2 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-xs" /> Clear
          </button>
        )}
      </div>

      {/* Feed */}
      <div className="overflow-hidden rounded-xl border border-card-border bg-card">
        <div className="flex items-center gap-2 border-b border-card-border px-3 py-2 text-xs">
          <Icon icon="heroicons-outline:signal" className="text-sm text-blue-500" />
          <span className="font-semibold text-foreground">Events</span>
          <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{events.length}</span>
          {total > events.length && <span className="text-[10px] text-muted/70">of {total}</span>}
          <button
            type="button"
            onClick={() => qc.invalidateQueries({ queryKey: ["vms-events"] })}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrow-path" className="text-xs" /> Refresh
          </button>
        </div>

        {q.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading events…
          </div>
        ) : q.isError ? (
          <div className="m-3 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
            <Icon icon="heroicons-outline:exclamation-circle" className="mt-0.5 shrink-0 text-sm" />
            <div>
              <p className="font-medium">Failed to load events</p>
              <p className="mt-0.5 text-[11px] opacity-80">{apiError(q.error, "Unknown error")}</p>
            </div>
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Icon icon="heroicons-outline:bell-slash" className="mb-2 text-2xl text-muted" />
            <p className="text-sm text-muted">No camera events</p>
            <p className="text-[11px] text-muted/70">Device events appear here as cameras report them.</p>
          </div>
        ) : (
          <div className="divide-y divide-card-border">
            {events.map((e, idx) => (
              <CameraEventRow
                key={eventKey(e, idx)}
                event={e}
                cameraName={cameraName(e.camera_id)}
                incidentId={incidentByEventId.get(e.event_id || e.id) || null}
                onAck={(ev) => ackMut.mutate(ev.id)}
                ackPending={ackMut.isPending && ackMut.variables === e.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterField({ label, children }) {
  return (
    <div className="min-w-[9rem]">
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{label}</label>
      {children}
    </div>
  );
}
