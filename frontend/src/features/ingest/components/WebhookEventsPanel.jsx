"use client";

// Inbound event-logs for a webhook — the "did my vendor's traffic land?" view.
//
// Filters on the single-value `status` (v2's taxonomy) rather than the per-stage
// outcome columns, because the interesting failures — no_rule_match,
// rejected_method — don't show up as a failed stage at all. Polls every 5s while
// open: this is the panel an operator watches while pointing a device at the URL
// for the first time, so a stale list reads as "nothing arrived".
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Spinner } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { STATUS_ALL, STATUS_FILTERS, STATUS_LABEL, STATUS_PILL } from "../constants";
import EventLogDetail from "./EventLogDetail";

const PAGE = 100;

// Received-at with seconds — kept local since the shared fmtDateTime omits seconds.
const fmt = (ts) =>
  ts
    ? new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

// One-line "what was in the body" for the row, without opening it.
function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") return "—";
  const keys = Object.keys(payload);
  if (!keys.length) return "(empty)";
  const head = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${head}, +${keys.length - 3} more` : head;
}

export default function WebhookEventsPanel({ hookId, canManage }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(STATUS_ALL);
  const [expanded, setExpanded] = useState(null);

  const key = ["ingest-event-logs", hookId, status];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      ingestApi.eventLogs.list({
        webhook_id: hookId,
        limit: PAGE,
        ...(status === STATUS_ALL ? {} : { status }),
      }),
    refetchInterval: 5000,
  });
  const rows = asItems(q.data);
  const total = q.data?.total ?? rows.length;

  const replay = useMutation({
    mutationFn: (id) => ingestApi.eventLogs.replay(id),
    onSuccess: () => {
      toast.success("Event replayed");
      qc.invalidateQueries({ queryKey: ["ingest-event-logs", hookId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-3">
      {/* Filters + refresh */}
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
              status === f.value
                ? "border-foreground bg-foreground text-background"
                : "border-card-border text-muted hover:bg-hover hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => q.refetch()}
          title="Refresh"
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon
            icon="heroicons-outline:arrow-path"
            className={`text-sm ${q.isFetching ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="!h-4 !w-4" /> Loading events…
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {status === STATUS_ALL
            ? "No inbound events recorded yet."
            : `No ${STATUS_LABEL[status]?.toLowerCase()} events.`}
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted">
            Showing {rows.length} of {total} API hit{total === 1 ? "" : "s"}
            {status === STATUS_ALL ? "" : ` · ${STATUS_LABEL[status]}`}
          </p>
          <ul className="divide-y divide-card-border rounded-lg border border-card-border">
            {rows.map((r) => {
              const open = expanded === r.id;
              return (
                <li key={r.id} className="text-sm">
                  <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-hover">
                    <button
                      onClick={() => setExpanded(open ? null : r.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Icon
                        icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"}
                        className="shrink-0 text-sm text-muted"
                      />
                      <span
                        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                          STATUS_PILL[r.status] || "border-card-border bg-hover text-muted"
                        }`}
                      >
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted">{fmt(r.received_at)}</span>
                      {r.source_ip && (
                        <span className="shrink-0 font-mono text-[11px] text-muted/70">{r.source_ip}</span>
                      )}
                      <span className="truncate text-[11px] text-muted/70">
                        {summarizePayload(r.raw_payload)}
                      </span>
                      {r.is_replay && (
                        <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                          replay
                        </span>
                      )}
                    </button>
                    {canManage && (
                      <button
                        onClick={() => replay.mutate(r.id)}
                        disabled={replay.isPending || r.raw_truncated}
                        title={r.raw_truncated ? "Payload was truncated — cannot replay" : "Replay"}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-blue-500 disabled:opacity-40"
                      >
                        <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
                      </button>
                    )}
                  </div>
                  {open && <EventLogDetail id={r.id} summary={r} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
