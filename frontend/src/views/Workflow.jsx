"use client";

// Workflow — INCIDENTS list. Ported from neubit_v2's workflow/events incident list,
// rethemed to neubit_v3's Vercel tokens + kit components. Filters (status / priority /
// site / sop), status + priority badges, assignee, click-through to the detail view.
//
// Near-real-time: TanStack Query `refetchInterval` polls every ~10s. True realtime
// (SSE/WS) will come later via the core realtime-bridge — see the comment on the query.
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "@/lib/api/workflow";
import { sites as sitesApi } from "@/lib/api/sites";

const rowId = (it) => it.id ?? it.instance_id;

// Domain statuses mirror neubit_v2's incident lifecycle (pending→active→…→completed).
export const INCIDENT_STATUSES = ["pending", "active", "paused", "completed", "cancelled"];
export const PRIORITIES = ["low", "medium", "high", "critical"];

// status → kit Badge color
export const STATUS_COLOR = {
  pending: "amber",
  active: "blue",
  paused: "amber",
  completed: "green",
  cancelled: "neutral",
};
// priority → kit Badge color
export const PRIORITY_COLOR = {
  low: "slate",
  medium: "blue",
  high: "amber",
  critical: "red",
};

export const titleize = (s) => (s ? String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "—");

function fmtWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const asItems = (d) => (Array.isArray(d) ? d : d?.items || []);

export default function WorkflowPage() {
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [siteId, setSiteId] = useState("");
  const [sopId, setSopId] = useState("");

  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);
  const sitesList = asItems(sitesQ.data);

  // NOTE: polling for near-real-time. Replace with the core realtime-bridge (SSE/WS)
  // when available so incidents stream in without a 10s poll.
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
    refetchInterval: 10000,
  });

  const instances = asItems(instancesQ.data);
  const total = instancesQ.data?.total ?? instances.length;

  const qc = useQueryClient();

  // Stats strip (defensive: if the /stats endpoint isn't live yet, retry:false hides it).
  const statsQ = useQuery({
    queryKey: ["wf-stats"],
    queryFn: () => wfApi.instances.stats(),
    retry: false,
    refetchInterval: 15000,
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

  const selCls =
    "h-9 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted";

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

      {/* Stats strip — click a tile to filter by that status */}
      {statusCounts && (
        <div className="mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[{ k: "", label: "Total" }, ...INCIDENT_STATUSES.map((s) => ({ k: s, label: titleize(s) }))].map(({ k, label }) => {
            const count = k === "" ? (statusCounts.total ?? total) : (Number(statusCounts[k]) || 0);
            const isActive = status === k;
            return (
              <button
                key={k || "total"}
                onClick={() => setStatus(k)}
                className={`rounded-xl border px-3 py-2.5 text-left transition ${isActive ? "border-foreground bg-hover" : "border-card-border hover:bg-hover"}`}
              >
                <div className="text-lg font-semibold text-foreground">{count}</div>
                <div className="text-[11px] text-muted">{label}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls}>
          <option value="" className="bg-card">All statuses</option>
          {INCIDENT_STATUSES.map((s) => (
            <option key={s} value={s} className="bg-card">{titleize(s)}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={selCls}>
          <option value="" className="bg-card">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p} className="bg-card">{titleize(p)}</option>
          ))}
        </select>
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={selCls}>
          <option value="" className="bg-card">All sites</option>
          {sitesList.map((s) => (
            <option key={s.site_id} value={s.site_id} className="bg-card">{s.name}</option>
          ))}
        </select>
        <select value={sopId} onChange={(e) => setSopId(e.target.value)} className={selCls}>
          <option value="" className="bg-card">All SOPs</option>
          {sops.map((s) => (
            <option key={s.id ?? s.sop_id} value={s.id ?? s.sop_id} className="bg-card">{s.name}</option>
          ))}
        </select>
        {(status || priority || siteId || sopId) && (
          <button
            onClick={() => {
              setStatus("");
              setPriority("");
              setSiteId("");
              setSopId("");
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-card-border px-2.5 h-9 text-xs text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-sm" /> Clear
          </button>
        )}
        <span className="ml-auto text-xs text-muted">{total} incident(s)</span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
          <span className="text-sm font-medium text-foreground">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => bulk.mutate("paused")} disabled={bulk.isPending} className="!px-3 !py-1.5 text-xs">Pause</Button>
            <Button variant="secondary" icon="heroicons-outline:arrow-trending-up" onClick={() => bulk.mutate("escalate")} disabled={bulk.isPending} className="!px-3 !py-1.5 text-xs">Escalate</Button>
            <Button variant="danger" onClick={() => bulk.mutate("cancelled")} disabled={bulk.isPending} className="!px-3 !py-1.5 text-xs">Cancel</Button>
            <button onClick={clearSel} className="text-xs text-muted hover:text-foreground px-2">Clear</button>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        {instancesQ.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : instances.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Icon icon="heroicons-outline:inbox" className="text-4xl text-muted mb-3 opacity-60" />
            <p className="text-foreground font-medium">No incidents</p>
            <p className="text-muted text-sm mt-1">
              {status || priority || siteId || sopId ? "Try clearing filters." : "Incidents will appear here as they are raised."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted border-b border-card-border">
                  <th className="w-10 px-4 py-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
                  <th className="font-medium px-4 py-3">Incident</th>
                  <th className="font-medium px-4 py-3">SOP</th>
                  <th className="font-medium px-4 py-3">State</th>
                  <th className="font-medium px-4 py-3">Status</th>
                  <th className="font-medium px-4 py-3">Priority</th>
                  <th className="font-medium px-4 py-3">Site</th>
                  <th className="font-medium px-4 py-3">Assignee</th>
                  <th className="font-medium px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((it) => {
                  const id = it.id ?? it.instance_id;
                  const sid = it.sop_id ?? it.sop?.id;
                  const siteRef = it.site_id ?? it.site?.site_id;
                  return (
                    <tr key={id} className="border-b border-card-border hover:bg-hover transition">
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} aria-label="Select incident" />
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/events/${id}`} className="flex flex-col">
                          <span className="font-medium text-foreground">{it.title || it.reference || `Incident ${String(id).slice(0, 8)}`}</span>
                          <span className="text-xs text-muted font-mono">{String(id).slice(0, 8)}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted">{it.sop_name || sopName[sid] || "—"}</td>
                      <td className="px-4 py-3">
                        <span className="text-foreground">{titleize(it.current_state || it.state)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={STATUS_COLOR[it.status] || "neutral"}>{titleize(it.status)}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={PRIORITY_COLOR[it.priority] || "neutral"}>{titleize(it.priority)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted">{it.site_name || siteName[siteRef] || "—"}</td>
                      <td className="px-4 py-3 text-muted">
                        {it.assignee_name || it.assignee?.full_name || it.assignee?.email || "Unassigned"}
                      </td>
                      <td className="px-4 py-3 text-muted">{fmtWhen(it.updated_at || it.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
