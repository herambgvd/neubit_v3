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
    <div className="px-4 py-3 bg-hover/30 border-t border-card-border space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted"><Spinner className="!h-3.5 !w-3.5" /> Loading…</div>
      ) : (
        <>
          <div>
            <FieldLabel>Raw payload</FieldLabel>
            <pre className="mt-1 rounded-lg border border-field bg-card px-3 py-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {d?.raw_payload ? JSON.stringify(d.raw_payload, null, 2) : "—"}{d?.raw_truncated ? "\n… (truncated)" : ""}
            </pre>
          </div>
          <div>
            <FieldLabel>Transformed</FieldLabel>
            <pre className="mt-1 rounded-lg border border-field bg-card px-3 py-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {d?.transformed_payload ? JSON.stringify(d.transformed_payload, null, 2) : "—"}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
