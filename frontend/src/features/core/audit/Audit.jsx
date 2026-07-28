"use client";

// Audit log console — a read-only, paginated record of actions across the platform,
// styled like the Users & Roles console (navy, compact). Owns the paged query + page
// state and gates the admin-only retention controls behind settings.manage.
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { actionColor, describe, formatTs } from "./auditFormat";

const PAGE_SIZE = 25;

// Map the kit Badge colour name → navy console pill classes.
const PILL = {
  green: "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good",
  red: "border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.1)] text-nb-crit",
  amber: "border-[rgba(251,191,36,.5)] bg-[rgba(251,191,36,.1)] text-nb-warn",
  blue: "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] text-nb-blueb",
  slate: "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted",
};

function RetentionBar({ total }) {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["audit-retention"], queryFn: () => api.get("/audit/retention").then((r) => r.data) });
  const [days, setDays] = useState("");
  const [confirm, setConfirm] = useState(null);
  useEffect(() => {
    if (info.data) setDays(String(info.data.retention_days ?? 0));
  }, [info.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["audit-retention"] });
    qc.invalidateQueries({ queryKey: ["audit"] });
  };
  const savePolicy = useMutation({
    mutationFn: () => api.put("/settings", { values: { audit_retention_days: Number(days) || 0 } }),
    onSuccess: () => { invalidate(); toast.success("Retention policy saved"); },
    onError: (e) => toast.error(apiError(e)),
  });
  const purge = useMutation({
    mutationFn: () => api.post("/audit/purge", {}),
    onSuccess: (r) => { invalidate(); setConfirm(null); toast.success(`Purged ${r.data.deleted} entr${r.data.deleted === 1 ? "y" : "ies"}`); },
    onError: (e) => toast.error(apiError(e)),
  });
  const policyDays = Number(days) || 0;
  const cnt = info.data?.total ?? total;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Icon icon="heroicons-outline:archive-box" className="text-sm text-nb-blueb" />
        <span className="text-[11px] font-semibold uppercase tracking-[1.2px] text-nb-muted">Data retention</span>
      </div>
      <span className="text-[11.5px] text-nb-faint">
        {cnt != null ? `${cnt} entries stored · ` : ""}auto-delete older than the window · 0 keeps forever
      </span>
      <span className="flex-1" />
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-nb-faint">Retention (days)</label>
        <input
          type="number"
          min="0"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="w-20 rounded-[7px] border border-nb-line bg-[rgba(0,0,0,.35)] px-2.5 py-1 font-mono text-[12.5px] text-nb-blueb outline-none focus:border-nb-teal"
        />
        <button
          onClick={() => savePolicy.mutate()}
          disabled={savePolicy.isPending}
          className="rounded-[7px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] px-3 py-1 text-[12px] text-nb-blueb transition hover:bg-[rgba(96,165,250,.16)] disabled:opacity-50"
        >
          {savePolicy.isPending ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() =>
            setConfirm({
              title: "Purge audit entries",
              message: `Permanently delete audit entries older than ${policyDays} days? This cannot be undone.`,
              confirmLabel: "Purge now",
              onConfirm: () => purge.mutate(),
            })
          }
          disabled={purge.isPending || policyDays <= 0}
          title={policyDays <= 0 ? "Set a positive retention window first" : "Delete entries older than the window now"}
          className="flex items-center gap-1.5 rounded-[7px] border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.1)] px-3 py-1 text-[12px] text-nb-crit transition hover:bg-[rgba(248,113,113,.16)] disabled:opacity-40"
        >
          <Icon icon="heroicons-outline:trash" className="text-[13px]" />
          {purge.isPending ? "Purging…" : "Purge now"}
        </button>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={purge.isPending} />
    </div>
  );
}

export default function AuditPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);

  const audit = useQuery({
    queryKey: ["audit", page],
    queryFn: () => api.get("/audit", { params: { page, page_size: PAGE_SIZE } }).then((r) => r.data),
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const data = audit.data;
  const items = data?.items || [];

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {can("settings.manage") && <RetentionBar total={data?.total} />}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)]">
        {/* header row */}
        <div className="grid grid-cols-[150px_1fr_150px_1.4fr] items-center gap-3 border-b border-nb-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[1px] text-nb-faint">
          <span>Time</span><span>Actor</span><span>Action</span><span>Activity</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {audit.isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center">
              <Icon icon="heroicons-outline:document-text" className="mx-auto text-2xl text-nb-faint" />
              <div className="mt-2 text-sm font-medium text-nb-ink">No audit entries yet</div>
              <div className="text-xs text-nb-faint">Actions performed in the app will appear here.</div>
            </div>
          ) : (
            items.map((r, i) => (
              <div
                key={r.id ?? i}
                className="grid grid-cols-[150px_1fr_150px_1.4fr] items-center gap-3 border-b border-nb-line/40 px-4 py-2 text-[12.5px] last:border-b-0 hover:bg-[rgba(96,165,250,.05)]"
              >
                <span className="font-mono text-[11.5px] text-nb-faint">{formatTs(r.ts)}</span>
                <span className="truncate font-medium text-nb-ink">{r.actor_email || "—"}</span>
                <span>
                  <span className={`inline-block rounded-[6px] border px-2 py-0.5 font-mono text-[10.5px] ${PILL[actionColor(r.action)] || PILL.slate}`}>
                    {r.action || "—"}
                  </span>
                </span>
                <span className="truncate text-nb-soft">{describe(r)}</span>
              </div>
            ))
          )}
        </div>

        {/* footer paging */}
        {items.length > 0 && (
          <div className="flex items-center justify-between border-t border-nb-line px-4 py-2.5">
            <p className="text-[11.5px] text-nb-faint">
              Page {data?.page ?? page}{data?.pages ? ` of ${data.pages}` : ""}
              {data?.total != null ? ` · ${data.total} entries` : ""}
            </p>
            <div className="flex items-center gap-2">
              <button
                disabled={!data?.has_prev || audit.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="flex items-center gap-1 rounded-[7px] border border-nb-line px-3 py-1 text-[12px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb disabled:opacity-40"
              >
                <Icon icon="heroicons-mini:chevron-left" className="text-[13px]" /> Prev
              </button>
              <button
                disabled={!data?.has_next || audit.isFetching}
                onClick={() => setPage((p) => p + 1)}
                className="flex items-center gap-1 rounded-[7px] border border-nb-line px-3 py-1 text-[12px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb disabled:opacity-40"
              >
                Next <Icon icon="heroicons-mini:chevron-right" className="text-[13px]" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
