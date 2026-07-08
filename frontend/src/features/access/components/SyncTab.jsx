"use client";

// Reconciliation history + on-demand trigger. Ported from neubit_v2's sync-tab.jsx:
// a "Sync now" button (v3 → POST /instances/{id}/reconcile) and an expandable list of
// the last sync jobs with status pill, trigger, duration, entity counts and errors.
//
// v3 difference: v3's reconcile queues a FULL reconcile (no per-entity `only` filter),
// so the entity-filter select from v2 is dropped. Jobs are read from
// GET /instances/{id}/sync-jobs (polled every 5s).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { asItems, fmtDateTime } from "@/lib/format";
import { gates } from "../api";

export default function SyncTab({ instanceId }) {
  const qc = useQueryClient();
  const [openJobs, setOpenJobs] = useState(() => new Set());

  const q = useQuery({
    queryKey: ["ac-sync-jobs", instanceId],
    queryFn: () => gates.instances.syncJobs(instanceId, { limit: 50 }),
    enabled: !!instanceId,
    refetchInterval: 5000,
  });
  const jobs = asItems(q.data);

  const trigger = useMutation({
    mutationFn: () => gates.instances.reconcile(instanceId),
    onSuccess: (job) => {
      const id = String(job?.id || "").slice(0, 8) || "—";
      const s = String(job?.status || "").toLowerCase();
      if (s === "succeeded" || s === "completed" || s === "success") toast.success(`Sync completed · job ${id}`);
      else if (s === "partial") toast.warning(`Sync partial · job ${id}`);
      else if (s === "failed" || s === "error") toast.error(`Sync failed · job ${id}`);
      else toast.success(`Sync started · job ${id}`);
      qc.invalidateQueries({ queryKey: ["ac-sync-jobs", instanceId] });
    },
    onError: (e) => toast.error(apiError(e, "Sync failed")),
  });

  const toggle = (id) =>
    setOpenJobs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border pb-3">
        <Icon icon="heroicons-outline:clock" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Sync History</span>
        <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{jobs.length}</span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => trigger.mutate()}
            disabled={trigger.isPending}
            className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-green-500 disabled:opacity-50"
          >
            <Icon icon={trigger.isPending ? "svg-spinners:180-ring" : "heroicons-outline:arrow-path"} className="text-xs" />
            Sync now
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pt-2">
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
          </div>
        ) : q.isError ? (
          <div className="mx-2 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
            <p className="font-medium">Failed to load sync jobs</p>
            <p className="mt-1 opacity-90">{apiError(q.error, "Unknown error")}</p>
          </div>
        ) : jobs.length === 0 ? (
          <div className="py-12 text-center text-xs text-muted/70">
            No sync runs yet — click <span className="font-medium">Sync now</span> to kick off the first reconcile.
          </div>
        ) : (
          <div className="divide-y divide-card-border">
            {jobs.map((j) => {
              const id = j.id || j._id || `${j.started_at}`;
              return <JobRow key={id} job={j} open={openJobs.has(id)} onToggle={() => toggle(id)} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job, open, onToggle }) {
  const s = String(job.status || "").toLowerCase();
  const isOk = s === "success" || s === "completed" || s === "succeeded";
  const isRunning = s === "running" || s === "pending";
  const isFail = s === "failed" || s === "error";
  const isPartial = s === "partial";
  const tone = isOk
    ? "bg-green-500/10 text-green-500"
    : isPartial
      ? "bg-amber-500/10 text-amber-500"
      : isRunning
        ? "bg-blue-500/10 text-blue-500"
        : isFail
          ? "bg-red-500/10 text-red-500"
          : "bg-hover text-muted";
  const icon = isOk ? "heroicons-outline:check-circle" : isFail ? "heroicons-outline:exclamation-circle" : "svg-spinners:180-ring";
  const counts = job.counts || job.entity_counts || {};

  return (
    <div className="px-2 py-2 text-xs">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 text-left">
        <Icon icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="shrink-0 text-xs text-muted" />
        <Icon icon={icon} className={`shrink-0 text-sm ${isRunning ? "" : ""}`} />
        <span className="w-36 shrink-0 font-mono text-[10px] text-muted">{fmtDateTime(job.started_at || job.created_at)}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase ${tone}`}>{job.status || "—"}</span>
        <span className="text-muted">{job.trigger || "manual"}</span>
        <span className="ml-auto font-mono text-[10px] text-muted/70">{durationOf(job)}</span>
      </button>
      {open && (
        <div className="ml-5 mt-2 space-y-2">
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <KV label="Job id" value={job.id || job._id} />
            <KV label="Started" value={fmtDateTime(job.started_at)} />
            <KV label="Finished" value={fmtDateTime(job.finished_at)} />
            <KV label="Trigger" value={job.trigger} />
            <KV label="Only" value={(job.only || []).join(", ") || "all"} />
            <KV label="Errors" value={Array.isArray(job.errors) ? job.errors.length : "0"} />
          </div>
          {Object.keys(counts).length > 0 && (
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-muted/70">Entity counts</div>
              <CountsCell counts={counts} />
            </div>
          )}
          {Array.isArray(job.errors) && job.errors.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded border border-red-500/20 bg-red-500/10 p-2 text-[10px] text-red-500">
              {JSON.stringify(job.errors, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted/70">{label}</div>
      <div className="truncate font-mono text-[10px] text-muted">{value || "—"}</div>
    </div>
  );
}

function CountsCell({ counts }) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return <span className="text-[10px] text-muted/70">—</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([k, v]) => {
        const c = typeof v === "object" && v !== null ? v : {};
        return (
          <div key={k} className="rounded border border-card-border bg-hover px-2 py-1 text-[10px] leading-tight">
            <div className="mb-0.5 font-semibold uppercase tracking-wider text-muted">{k.replace(/_/g, " ")}</div>
            {typeof v === "object" && v !== null ? (
              <div className="flex gap-2">
                <span className="text-green-500">+{c.added || 0}</span>
                <span className="text-blue-500">~{c.updated || 0}</span>
                <span className="text-red-500">−{c.removed || 0}</span>
                {(c.errors || 0) > 0 && <span className="text-amber-500">!{c.errors}</span>}
              </div>
            ) : (
              <span className="font-mono text-muted">{v}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function durationOf(job) {
  if (!job.started_at) return "";
  const start = new Date(job.started_at).getTime();
  const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
