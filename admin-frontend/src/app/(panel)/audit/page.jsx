"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ScrollText, Search } from "lucide-react";

import { adminApi, apiError } from "@/lib/api";

function fmtTs(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Map action verbs → tone. create=emerald, delete/suspend=red, update/patch=amber, else slate.
function actionTone(action) {
  const a = (action || "").toLowerCase();
  if (/(create|add|reactivate|start|grant|login)/.test(a)) return "emerald";
  if (/(delete|remove|suspend|revoke|stop|fail)/.test(a)) return "red";
  if (/(update|patch|edit|change|scale|set)/.test(a)) return "amber";
  return "slate";
}

const TONE = {
  emerald: "border-emerald-400/20 bg-emerald-500/10 text-emerald-300",
  red: "border-red-400/20 bg-red-500/10 text-red-300",
  amber: "border-amber-400/20 bg-amber-500/10 text-amber-300",
  slate: "border-white/10 bg-white/[0.04] text-slate-300",
};

function ActionBadge({ action }) {
  return (
    <span className={"rounded-full border px-2.5 py-0.5 text-xs font-medium " + TONE[actionTone(action)]}>
      {action || "—"}
    </span>
  );
}

export default function AuditPage() {
  const [tenantInput, setTenantInput] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["audit", { tenantId, page }],
    queryFn: () => adminApi.listAudit({ tenantId, page }),
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? items.length;
  const pageSize = data?.page_size ?? items.length ?? 20;
  const pages = Math.max(1, Math.ceil(total / (pageSize || 20)));

  function applyFilter(e) {
    e.preventDefault();
    setTenantId(tenantInput.trim());
    setPage(1);
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-white">Audit log</h1>
        <p className="mt-1 text-sm text-slate-400">
          Cross-tenant record of privileged actions. Filter by a specific tenant or view all.
        </p>
      </div>

      {/* Tenant filter */}
      <form onSubmit={applyFilter} className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={tenantInput}
            onChange={(e) => setTenantInput(e.target.value)}
            placeholder="Filter by tenant_id (leave blank for all)…"
            className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.04] pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
          />
        </div>
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
        >
          Apply
        </button>
        {tenantId && (
          <button
            type="button"
            onClick={() => {
              setTenantInput("");
              setTenantId("");
              setPage(1);
            }}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:text-white"
          >
            Clear
          </button>
        )}
      </form>

      {tenantId && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-300">
          Filtering tenant <span className="font-mono">{tenantId}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 font-medium">Time</th>
              <th className="px-5 py-3 font-medium">Actor</th>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Target</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows />}

            {isError && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-sm text-red-300">
                  {apiError(error, "Failed to load audit log")}
                </td>
              </tr>
            )}

            {!isLoading && !isError && items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-cyan-300">
                      <ScrollText className="h-5 w-5" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-slate-200">No audit entries</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {tenantId ? "No activity for this tenant." : "No privileged actions recorded yet."}
                    </p>
                  </div>
                </td>
              </tr>
            )}

            {!isLoading &&
              !isError &&
              items.map((row) => (
                <tr key={row.id} className="border-b border-white/5 last:border-0 transition hover:bg-white/[0.03]">
                  <td className="whitespace-nowrap px-5 py-3.5 text-slate-400 tabular-nums">{fmtTs(row.ts)}</td>
                  <td className="px-5 py-3.5">
                    <span className="font-medium text-white">{row.actor || "—"}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <ActionBadge action={row.action} />
                  </td>
                  <td className="px-5 py-3.5 text-slate-300">
                    {row.target_type || row.target_id ? (
                      <span>
                        <span className="text-slate-400">{row.target_type || "—"}</span>
                        {row.target_id ? <span className="font-mono text-xs text-slate-500"> · {row.target_id}</span> : null}
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
        <span>
          {total} entr{total === 1 ? "y" : "ies"}
          {isFetching ? " · updating…" : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 transition hover:border-white/20 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="tabular-nums">
            Page {page} / {pages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 transition hover:border-white/20 disabled:opacity-40"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return Array.from({ length: 8 }).map((_, i) => (
    <tr key={i} className="border-b border-white/5 last:border-0">
      {Array.from({ length: 4 }).map((__, j) => (
        <td key={j} className="px-5 py-4">
          <div className="h-3.5 w-full max-w-[140px] animate-pulse rounded bg-white/10" />
        </td>
      ))}
    </tr>
  ));
}
