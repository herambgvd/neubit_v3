"use client";

// Recent inbound event-logs for a webhook + per-row replay. Rows expand to show
// raw/transformed payloads (<EventLogDetail>).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Spinner } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { OUTCOME_PILL } from "../constants";
import EventLogDetail from "./EventLogDetail";

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

export default function WebhookEventsPanel({ hookId }) {
  const qc = useQueryClient();
  const key = ["ingest-event-logs", hookId];
  const q = useQuery({ queryKey: key, queryFn: () => ingestApi.eventLogs.list({ webhook_id: hookId, limit: 30 }) });
  const rows = asItems(q.data);
  const [expanded, setExpanded] = useState(null);

  const replay = useMutation({
    mutationFn: (id) => ingestApi.eventLogs.replay(id),
    onSuccess: () => { toast.success("Event replayed"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => toast.error(apiError(e)),
  });

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading events…</div>;
  if (rows.length === 0) return <p className="text-sm text-muted py-6 text-center">No inbound events recorded yet.</p>;

  return (
    <ul className="rounded-lg border border-card-border divide-y divide-card-border">
      {rows.map((r) => {
        const open = expanded === r.id;
        return (
          <li key={r.id} className="text-sm">
            <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-hover">
              <button onClick={() => setExpanded(open ? null : r.id)} className="flex-1 flex items-center gap-2 text-left min-w-0">
                <Icon icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="text-muted text-sm shrink-0" />
                <span className="text-xs text-muted font-mono shrink-0">{fmt(r.received_at)}</span>
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${OUTCOME_PILL[r.auth_outcome] || OUTCOME_PILL.skipped}`}>auth {r.auth_outcome}</span>
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${OUTCOME_PILL[r.schema_outcome] || OUTCOME_PILL.skipped}`}>schema {r.schema_outcome}</span>
                {r.published ? (
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-green-500/10 text-green-500">published</span>
                ) : (
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted">not published</span>
                )}
                {r.is_replay && <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-blue-500/10 text-blue-500">replay</span>}
              </button>
              <button onClick={() => replay.mutate(r.id)} disabled={replay.isPending} title="Replay" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-blue-500 shrink-0 disabled:opacity-50">
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
            </div>
            {open && <EventLogDetail id={r.id} error={r.error} />}
          </li>
        );
      })}
    </ul>
  );
}
