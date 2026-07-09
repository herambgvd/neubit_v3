"use client";

// Four-eyes dual-authorization ledger (P6-D). Sensitive actions (bulk delete,
// export, erasure, …) can require a second privileged user to approve before they
// run. This panel lists requests by status and lets an approver approve/deny them.
// Approve/deny gate on dualauth.approve (a DISTINCT permission from security.manage).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, fmtDateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { security } from "../api";

const STATUS_TABS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "consumed", label: "Consumed" },
  { value: "", label: "All" },
];

const STATUS_STYLE = {
  pending: "bg-amber-500/15 text-amber-500",
  approved: "bg-emerald-500/15 text-emerald-500",
  denied: "bg-red-500/15 text-red-500",
  consumed: "bg-hover text-muted",
  expired: "bg-hover text-muted",
};

export default function DualAuthPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canApprove = can("dualauth.approve");
  const [status, setStatus] = useState("pending");

  const q = useQuery({
    queryKey: ["security-dual-auth", status],
    queryFn: () => security.dualAuth.list({ status: status || undefined, size: 100 }),
    refetchInterval: 15_000,
  });
  const items = useMemo(() => asItems(q.data), [q.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["security-dual-auth"] });

  const approve = useMutation({
    mutationFn: (id) => security.dualAuth.approve(id, undefined),
    onSuccess: () => {
      toast.success("Request approved");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Approve failed")),
  });
  const deny = useMutation({
    mutationFn: (id) => security.dualAuth.deny(id, undefined),
    onSuccess: () => {
      toast.success("Request denied");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Deny failed")),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-card-border bg-hover/40">
          <Icon icon="heroicons-outline:user-group" className="text-lg text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Dual authorization (four-eyes)</h2>
          <p className="mt-0.5 text-xs text-muted">
            Sensitive actions raise a request that a different privileged user must approve before they run.
          </p>
        </div>
        <Button variant="secondary" icon="heroicons-outline:arrow-path" onClick={() => invalidate()}>
          Refresh
        </Button>
      </div>

      {/* Status filter */}
      <div className="mb-3 flex flex-wrap gap-1">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value || "all"}
            onClick={() => setStatus(t.value)}
            className={`rounded-md px-2.5 py-1 text-xs transition ${
              status === t.value ? "bg-hover text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!canApprove && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-card-border bg-hover/30 px-3 py-2 text-xs text-muted">
          <Icon icon="heroicons-outline:lock-closed" className="mt-0.5 shrink-0" />
          You can view requests, but approving/denying requires the <code className="mx-1">dualauth.approve</code> permission.
        </div>
      )}

      {q.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading requests…
        </div>
      ) : q.isError ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-500">
          {apiError(q.error, "Failed to load requests")}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-card-border py-12 text-center">
          <Icon icon="heroicons-outline:check-circle" className="mb-2 text-3xl text-muted opacity-50" />
          <p className="text-sm font-medium text-foreground">No {status || ""} requests</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <div key={r.id} className="rounded-lg border border-card-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{r.action}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[r.status] || "bg-hover text-muted"}`}>
                      {r.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {r.target_type ? `${r.target_type}` : "—"}
                    {r.target_id ? ` · ${r.target_id}` : ""}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    Requested by {r.requested_by_email || r.requested_by || "unknown"} · {fmtDateTime(r.created_at)}
                    {r.decided_by_email && (
                      <>
                        {" · "}
                        {r.status === "approved" ? "approved" : r.status === "denied" ? "denied" : "decided"} by{" "}
                        {r.decided_by_email}
                      </>
                    )}
                  </p>
                </div>
                {r.status === "pending" && canApprove && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="success"
                      icon="heroicons-outline:check"
                      disabled={approve.isPending || deny.isPending}
                      onClick={() => approve.mutate(r.id)}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      icon="heroicons-outline:x-mark"
                      disabled={approve.isPending || deny.isPending}
                      onClick={() => deny.mutate(r.id)}
                    >
                      Deny
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
