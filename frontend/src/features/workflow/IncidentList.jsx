"use client";

// Workflow — EVENTS (route /events): a live alarm monitor in the style of Genetec
// Security Center / Milestone Alarm Manager. Two views over the same incident
// stream:
//   • Board (default) — rich AlarmCards (severity band, SLA countdown, NEW marker,
//     inline Ack/Assign) sorted most-urgent-first.
//   • Map — a floor-plan situational map placing incident markers by zone.
//
// A situational StatHeader (Critical open / Active / SLA breaching / Unassigned) +
// a PriorityBar sit above both. The existing filters, bulk actions, pagination and
// click-through to IncidentDetail are all preserved.
//
// Realtime: useIncidentStream (core SSE bridge) drives list/stat refresh, the
// Live/Reconnecting badge (onStatus), and NEW-highlighting of just-arrived
// incidents; a slow poll is the safety-net.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { PageHeader } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { workflow as wfApi } from "./api";
import IncidentFilters from "./components/incidents/IncidentFilters";
import IncidentBulkBar from "./components/incidents/IncidentBulkBar";
import StatHeader from "./components/incidents/StatHeader";
import PriorityBar from "./components/incidents/PriorityBar";
import ViewToggle from "./components/incidents/ViewToggle";
import AlarmBoard from "./components/incidents/AlarmBoard";
import IncidentMap from "./components/incidents/IncidentMap";
import AssignModal from "./components/detail/AssignModal";
import { useIncidentStream } from "./hooks/useIncidentStream";
import { incId, incAssignedId, isOpen, isSlaBreaching, NEW_WINDOW_MS } from "./components/incidents/lib";

// Re-export domain constants from their canonical home for any legacy consumers.
export { STATUS_COLOR, PRIORITY_COLOR, INCIDENT_STATUSES, PRIORITIES } from "./constants";

const rowId = (it) => incId(it);
const PAGE_SIZE = 25;

// Small debounce so the search input doesn't refire the query on every keystroke.
function useDebounced(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export default function WorkflowPage() {
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput, 300);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [siteId, setSiteId] = useState("");
  const [sopId, setSopId] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(0);
  const [view, setView] = useState("board");

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [q, status, priority, siteId, sopId, source]);

  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);
  const sitesList = asItems(sitesQ.data);

  const instancesQ = useQuery({
    queryKey: ["wf-instances", { q, status, priority, siteId, sopId, source, page }],
    queryFn: () =>
      wfApi.instances.list({
        q: q || undefined,
        status: status || undefined,
        priority: priority || undefined,
        site_id: siteId || undefined,
        sop_id: sopId || undefined,
        source: source || undefined,
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    keepPreviousData: true,
    refetchInterval: 60000,
  });

  const instances = asItems(instancesQ.data);
  const total = instancesQ.data?.total ?? instances.length;

  const qc = useQueryClient();

  // NEW tracking: ids first seen via SSE (or freshly-created) glow for a short
  // window. We stamp each id with its first-seen time and prune on read.
  const [newSeen, setNewSeen] = useState(() => new Map()); // id -> ts
  const stampNew = (id) =>
    setNewSeen((m) => {
      const n = new Map(m);
      n.set(String(id), Date.now());
      return n;
    });

  // Live incidents push (SSE). On each incident.created / trigger.fired, refresh
  // the list + stats immediately and mark the incident NEW. The badge reflects the
  // REAL SSE connection state (onopen → Live, onerror → Reconnecting).
  const [connected, setConnected] = useState(false);
  useIncidentStream(
    (evt) => {
      const id = evt?.data?.instance_id ?? evt?.data?.id;
      if (id) stampNew(id);
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      qc.invalidateQueries({ queryKey: ["wf-stats"] });
    },
    { onStatus: setConnected },
  );

  // Prune expired NEW stamps roughly once the window passes so the glow clears.
  useEffect(() => {
    if (newSeen.size === 0) return undefined;
    const t = setInterval(() => {
      setNewSeen((m) => {
        const now = Date.now();
        let changed = false;
        const n = new Map();
        for (const [k, v] of m) {
          if (now - v < NEW_WINDOW_MS) n.set(k, v);
          else changed = true;
        }
        return changed ? n : m;
      });
    }, 15000);
    return () => clearInterval(t);
  }, [newSeen.size]);

  // Set of ids currently "new" (fresh SSE stamp OR created within the window).
  const newIds = useMemo(() => {
    const now = Date.now();
    const s = new Set();
    for (const [k, v] of newSeen) if (now - v < NEW_WINDOW_MS) s.add(k);
    for (const it of instances) {
      const c = it.created_at ? new Date(it.created_at).getTime() : 0;
      if (c && now - c < NEW_WINDOW_MS) s.add(String(rowId(it)));
    }
    return s;
  }, [newSeen, instances]);

  // Stats strip (defensive: if the /stats endpoint isn't live, retry:false hides it).
  const statsQ = useQuery({
    queryKey: ["wf-stats"],
    queryFn: () => wfApi.instances.stats(),
    retry: false,
    refetchInterval: 60000,
  });
  const byStatus = statsQ.data?.by_status || null;
  const byPriority = statsQ.data?.by_priority || null;

  // Situational metrics. "Active" comes from the stats endpoint (deployment-wide).
  // "Critical open" prefers stats but subtracts terminal via the loaded page when
  // needed; SLA-breaching + Unassigned are computed from the loaded page (the
  // fields aren't in /stats). Documented as "on this page" in the tile hints.
  const criticalOpen = useMemo(() => {
    // by_priority is a total (not split by open/closed); the loaded page lets us
    // count *open* criticals precisely for the current filter context.
    const fromPage = instances.filter((it) => it.priority === "critical" && isOpen(it.status)).length;
    // If unfiltered and stats has it, prefer the (larger) stats number.
    const statNum = Number(byPriority?.critical);
    return Number.isFinite(statNum) && !status && !priority ? Math.max(statNum, fromPage) : fromPage;
  }, [instances, byPriority, status, priority]);

  const activeCount = useMemo(() => {
    const statNum = Number(byStatus?.active);
    if (Number.isFinite(statNum) && !status && !priority && !siteId && !sopId && !q) return statNum;
    return instances.filter((it) => it.status === "active").length;
  }, [byStatus, instances, status, priority, siteId, sopId, q]);

  const slaBreaching = useMemo(
    () => instances.filter((it) => isSlaBreaching(it)).length,
    [instances],
  );
  const unassigned = useMemo(
    () => instances.filter((it) => isOpen(it.status) && !incAssignedId(it)).length,
    [instances],
  );

  // Bulk selection over the current page.
  const [selected, setSelected] = useState(() => new Set());
  const toggle = (id) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const allSelected = instances.length > 0 && instances.every((it) => selected.has(rowId(it)));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(instances.map(rowId)));

  const bulk = useMutation({
    mutationFn: async (kind) => {
      const ids = [...selected];
      const fn = kind === "escalate"
        ? (id) => wfApi.instances.escalate(id, null)
        : (id) => wfApi.instances.setStatus(id, kind, null); // 'paused' | 'cancelled'
      const results = await Promise.allSettled(ids.map(fn));
      return { total: ids.length, failed: results.filter((r) => r.status === "rejected").length };
    },
    onSuccess: ({ total: n, failed }) => {
      (failed ? toast.warning : toast.success)(`${n - failed}/${n} updated${failed ? ` · ${failed} not applicable` : ""}`);
      clearSel();
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      statsQ.refetch();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Inline quick action: Acknowledge = activate a pending incident (matches
  // STATUS_ACTIONS in IncidentActionBar). Reuses the real status endpoint.
  const quick = useMutation({
    mutationFn: ({ id }) => wfApi.instances.setStatus(id, "active", null),
    onSuccess: () => {
      toast.success("Incident acknowledged");
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      statsQ.refetch();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const onAck = (it) => quick.mutate({ id: rowId(it) });

  // Assign quick action opens the shared AssignModal for that incident.
  const [assignFor, setAssignFor] = useState(null);
  const onAssign = (it) => setAssignFor(it);

  const sopName = useMemo(() => {
    const m = {};
    for (const s of sops) m[s.id ?? s.sop_id] = s.name;
    return m;
  }, [sops]);
  const siteName = useMemo(() => {
    const m = {};
    for (const s of sitesList) m[s.site_id] = s.name;
    return m;
  }, [sitesList]);

  const clearFilters = () => {
    setQInput("");
    setStatus("");
    setPriority("");
    setSiteId("");
    setSopId("");
    setSource("");
  };

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            Incidents
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2 py-0.5 text-[11px] font-normal text-muted"
              title={connected ? "Live stream connected" : "Live stream connecting…"}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`}
              />
              {connected ? "Live" : "Reconnecting…"}
            </span>
          </span>
        }
        subtitle="Live alarm monitor — track and respond to incidents driven by standard operating procedures."
        actions={
          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={setView} />
            <Link
              href="/workflow-config"
              className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
            >
              <Icon icon="heroicons-outline:cog-6-tooth" className="text-base" />
              Configure
            </Link>
            <Link
              href="/workflow-config"
              className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
            >
              <Icon icon="heroicons-outline:clipboard-document-list" className="text-base" />
              SOPs
            </Link>
          </div>
        }
      />

      <StatHeader
        criticalOpen={criticalOpen}
        active={activeCount}
        slaBreaching={slaBreaching}
        unassigned={unassigned}
        activePriority={priority}
        activeStatus={status}
        onPriority={setPriority}
        onStatus={setStatus}
      />

      <PriorityBar byPriority={byPriority} />

      <IncidentFilters
        qInput={qInput}
        onQInput={setQInput}
        status={status}
        priority={priority}
        siteId={siteId}
        sopId={sopId}
        source={source}
        onStatus={setStatus}
        onPriority={setPriority}
        onSite={setSiteId}
        onSop={setSopId}
        onSource={setSource}
        onClear={clearFilters}
        sites={sitesList}
        sops={sops}
        total={total}
      />

      <IncidentBulkBar
        count={selected.size}
        pending={bulk.isPending}
        onAction={(kind) => bulk.mutate(kind)}
        onClear={clearSel}
      />

      {view === "map" ? (
        <IncidentMap
          incidents={instances}
          sites={sitesList}
          siteName={siteName}
          sopName={sopName}
        />
      ) : (
        <AlarmBoard
          rows={instances}
          loading={instancesQ.isLoading}
          hasFilters={!!(q || status || priority || siteId || sopId || source)}
          selected={selected}
          onToggle={toggle}
          allSelected={allSelected}
          onToggleAll={toggleAll}
          sopName={sopName}
          siteName={siteName}
          newIds={newIds}
          onAck={onAck}
          onAssign={onAssign}
          actionPending={quick.isPending}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          onPage={setPage}
        />
      )}

      {assignFor && (
        <AssignModal
          open={!!assignFor}
          onClose={() => setAssignFor(null)}
          instanceId={rowId(assignFor)}
          currentAssigneeId={incAssignedId(assignFor)}
          onAssigned={() => {
            qc.invalidateQueries({ queryKey: ["wf-instances"] });
            statsQ.refetch();
            setAssignFor(null);
          }}
        />
      )}
    </div>
  );
}
