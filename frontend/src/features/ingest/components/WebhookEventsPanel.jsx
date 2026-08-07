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
import { RowAction } from "@/components/console";

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

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-nb-soft"><Spinner className="!h-4 !w-4" /> Loading events…</div>;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-nb-faint">No inbound events recorded yet.</p>;

  return (
    <ul className="divide-y divide-nb-line/50 rounded-[10px] border border-nb-line">
      {rows.map((r) => {
        const open = expanded === r.id;
        return (
          <li key={r.id} className="text-sm">
            <div className="flex items-center gap-2 px-3 py-2.5 transition hover:bg-[rgba(96,165,250,.05)]">
              <button onClick={() => setExpanded(open ? null : r.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="shrink-0 text-sm text-nb-faint" />
                <span className="shrink-0 font-mono text-xs text-nb-faint">{fmt(r.received_at)}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${OUTCOME_PILL[r.auth_outcome] || OUTCOME_PILL.skipped}`}>auth {r.auth_outcome}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${OUTCOME_PILL[r.schema_outcome] || OUTCOME_PILL.skipped}`}>schema {r.schema_outcome}</span>
                {r.published ? (
                  <span className="rounded-full border border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] px-1.5 py-0.5 text-[10px] font-medium text-nb-good">published</span>
                ) : (
                  <span className="rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] px-1.5 py-0.5 text-[10px] font-medium text-nb-faint">not published</span>
                )}
                {r.is_replay && <span className="rounded-full border border-[rgba(96,165,250,.35)] bg-[rgba(96,165,250,.1)] px-1.5 py-0.5 text-[10px] font-medium text-nb-blueb">replay</span>}
              </button>
              <RowAction icon="heroicons-outline:arrow-path" title="Replay" disabled={replay.isPending} onClick={() => replay.mutate(r.id)} />
            </div>
            {open && <EventLogDetail id={r.id} error={r.error} />}
          </li>
        );
      })}
    </ul>
  );
}
