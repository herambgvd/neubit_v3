"use client";

// Workflow — INCIDENTS list (page entry; a route wrapper re-exports this default).
// Thin orchestrator: owns filters, bulk selection, and the queries; renders the
// stats strip, filter row, bulk bar, and table components.
//
// Near-real-time: TanStack Query `refetchInterval` polls every ~10s. True realtime
// (SSE/WS) will come later via the core realtime-bridge — see the comment on the query.
import Link from "next/link";
import { useMemo, useState } from "react";
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

export default function WorkflowPage() {
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [siteId, setSiteId] = useState("");
  const [sopId, setSopId] = useState("");

  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);
  const sitesList = asItems(sitesQ.data);

  // Realtime via the core SSE bridge (below) drives refreshes; the interval is just
  // a slow safety-net in case the stream drops.
  const instancesQ = useQuery({
    queryKey: ["wf-instances", { status, priority, siteId, sopId }],
    queryFn: () =>
      wfApi.instances.list({
        status: status || undefined,
        priority: priority || undefined,
        site_id: siteId || undefined,
        sop_id: sopId || undefined,
        limit: 100,
      }),
    refetchInterval: 60000,
  });

  const instances = asItems(instancesQ.data);
  const total = instancesQ.data?.total ?? instances.length;

  const qc = useQueryClient();

  // Live incidents push (SSE). On each incident.created / trigger.fired, refresh the
  // list + stats immediately instead of waiting for the safety-net poll.
  useIncidentStream(() => {
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
    setStatus("");
    setPriority("");
    setSiteId("");
    setSopId("");
  };

  return (
    <div>
      <PageHeader
        title="Events"
        subtitle="Track and respond to incidents driven by standard operating procedures."
        actions={
          <Link
            href="/workflow-config"
            className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
          >
            <Icon icon="heroicons-outline:cog-6-tooth" className="text-base" />
            Configure
          </Link>
        }
      />

      <IncidentStatsStrip statusCounts={statusCounts} total={total} active={status} onSelect={setStatus} />

      <IncidentFilters
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
        hasFilters={!!(status || priority || siteId || sopId)}
        selected={selected}
        onToggle={toggle}
        allSelected={allSelected}
        onToggleAll={toggleAll}
        sopName={sopName}
        siteName={siteName}
      />
    </div>
  );
}
