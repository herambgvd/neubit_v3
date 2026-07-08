"use client";

// Workflow — INCIDENTS list (page entry; a route wrapper re-exports this default).
// Thin orchestrator: owns filters, bulk selection, and the queries; renders the
// stats strip, filter row, bulk bar, and table components.
//
// Near-real-time: TanStack Query `refetchInterval` polls every ~10s. True realtime
// (SSE/WS) will come later via the core realtime-bridge — see the comment on the query.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { PageHeader } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { workflow as wfApi } from "./api";
import IncidentStatsStrip from "./components/incidents/IncidentStatsStrip";
import IncidentFilters from "./components/incidents/IncidentFilters";
import IncidentBulkBar from "./components/incidents/IncidentBulkBar";
import IncidentTable from "./components/incidents/IncidentTable";
import { useIncidentStream } from "./hooks/useIncidentStream";

// Re-export domain constants from their canonical home for any legacy consumers.
export { STATUS_COLOR, PRIORITY_COLOR, INCIDENT_STATUSES, PRIORITIES } from "./constants";

const rowId = (it) => it.id ?? it.instance_id;
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
  const [page, setPage] = useState(0);

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [q, status, priority, siteId, sopId]);

  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);
  const sitesList = asItems(sitesQ.data);

  // Realtime via the core SSE bridge (below) drives refreshes; the interval is just
  // a slow safety-net in case the stream drops.
  const instancesQ = useQuery({
    queryKey: ["wf-instances", { q, status, priority, siteId, sopId, page }],
    queryFn: () =>
      wfApi.instances.list({
        q: q || undefined,
        status: status || undefined,
        priority: priority || undefined,
        site_id: siteId || undefined,
        sop_id: sopId || undefined,
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    keepPreviousData: true,
    refetchInterval: 60000,
  });

  const instances = asItems(instancesQ.data);
  const total = instancesQ.data?.total ?? instances.length;

  const qc = useQueryClient();

  // Live incidents push (SSE). On each incident.created / trigger.fired, refresh the
  // list + stats immediately instead of waiting for the safety-net poll. The hook
  // doesn't report connection status, so we flip a best-effort "connected" flag the
  // first time any frame arrives — good enough for the Live/Offline indicator.
  const [connected, setConnected] = useState(false);
  useIncidentStream(() => {
    setConnected(true);
    qc.invalidateQueries({ queryKey: ["wf-instances"] });
    qc.invalidateQueries({ queryKey: ["wf-stats"] });
  });

  // Stats strip (defensive: if the /stats endpoint isn't live yet, retry:false hides it).
  const statsQ = useQuery({
    queryKey: ["wf-stats"],
    queryFn: () => wfApi.instances.stats(),
    retry: false,
    refetchInterval: 60000,
  });
  const statusCounts = useMemo(() => {
    const d = statsQ.data;
    if (!d) return null;
    return d.by_status || d.status || d.statuses || d.counts || d;
  }, [statsQ.data]);

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
  };

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            Events
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2 py-0.5 text-[11px] font-normal text-muted"
              title={connected ? "Live stream connected" : "Live stream connecting…"}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {connected ? "Live" : "Reconnecting…"}
            </span>
          </span>
        }
        subtitle="Track and respond to incidents driven by standard operating procedures."
        actions={
          <div className="flex items-center gap-2">
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

      <IncidentStatsStrip statusCounts={statusCounts} total={total} active={status} onSelect={setStatus} />

      <IncidentFilters
        qInput={qInput}
        onQInput={setQInput}
        status={status}
        priority={priority}
        siteId={siteId}
        sopId={sopId}
        onStatus={setStatus}
        onPriority={setPriority}
        onSite={setSiteId}
        onSop={setSopId}
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

      <IncidentTable
        rows={instances}
        loading={instancesQ.isLoading}
        hasFilters={!!(q || status || priority || siteId || sopId)}
        selected={selected}
        onToggle={toggle}
        allSelected={allSelected}
        onToggleAll={toggleAll}
        sopName={sopName}
        siteName={siteName}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPage={setPage}
      />
    </div>
  );
}
