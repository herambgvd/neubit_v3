"use client";

// Expanded event-log row — raw + transformed payloads, fetched on demand.
import { useQuery } from "@tanstack/react-query";

import { Spinner } from "@/components/ui/kit";
import { FieldLabel } from "@/components/common";
import { ingest as ingestApi } from "../api";

export default function EventLogDetail({ id, error }) {
  const q = useQuery({ queryKey: ["ingest-event-log", id], queryFn: () => ingestApi.eventLogs.get(id) });
  const d = q.data;
  return (
    <div className="space-y-3 border-t border-nb-line bg-[rgba(0,0,0,.2)] px-4 py-3">
      {error && <p className="text-xs text-nb-crit">{error}</p>}
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-nb-faint"><Spinner className="!h-3.5 !w-3.5" /> Loading…</div>
      ) : (
        <>
          <div>
            <FieldLabel>Raw payload</FieldLabel>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-2 font-mono text-[11px] text-nb-soft">
              {d?.raw_payload ? JSON.stringify(d.raw_payload, null, 2) : "—"}{d?.raw_truncated ? "\n… (truncated)" : ""}
            </pre>
          </div>
          <div>
            <FieldLabel>Transformed</FieldLabel>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-2 font-mono text-[11px] text-nb-soft">
              {d?.transformed_payload ? JSON.stringify(d.transformed_payload, null, 2) : "—"}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
