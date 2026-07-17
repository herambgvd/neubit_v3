"use client";

// Expanded event-log row — request meta, outcome, and both payload bodies.
// The bodies are fetched on demand (the list response omits them); everything
// else comes from the `summary` row the list already has, so the meta renders
// immediately instead of waiting on the fetch.
import { useQuery } from "@tanstack/react-query";

import { Spinner } from "@/components/ui/kit";
import { FieldLabel } from "@/components/common";
import { ingest as ingestApi } from "../api";
import { OUTCOME_PILL, STATUS_LABEL, STATUS_PILL } from "../constants";

function Meta({ label, value, mono }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`truncate text-xs text-foreground ${mono ? "font-mono" : ""}`} title={String(value)}>
        {String(value)}
      </dd>
    </div>
  );
}

export default function EventLogDetail({ id, summary }) {
  const q = useQuery({
    queryKey: ["ingest-event-log", id],
    queryFn: () => ingestApi.eventLogs.get(id),
  });
  const d = q.data || summary || {};

  return (
    <div className="space-y-3 border-t border-card-border bg-hover/30 px-4 py-3">
      {/* Outcome */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
            STATUS_PILL[d.status] || "border-card-border bg-hover text-muted"
          }`}
        >
          {STATUS_LABEL[d.status] || d.status}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${OUTCOME_PILL[d.auth_outcome] || OUTCOME_PILL.skipped}`}>
          auth {d.auth_outcome}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${OUTCOME_PILL[d.schema_outcome] || OUTCOME_PILL.skipped}`}>
          schema {d.schema_outcome}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${OUTCOME_PILL[d.transform_outcome] || OUTCOME_PILL.skipped}`}>
          transform {d.transform_outcome}
        </span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            d.published ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
          }`}
        >
          {d.published ? "published" : "not published"}
        </span>
      </div>

      {d.error && (
        <p className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500">
          {d.error}
        </p>
      )}

      {/* Request meta */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Meta label="Source IP" value={d.source_ip} mono />
        <Meta label="Event ID" value={d.event_id} mono />
        <Meta label="Target subject" value={d.target_subject} mono />
        <Meta label="Matched rule" value={d.matched_rule_id} mono />
        <Meta label="Device lookup value" value={d.device_lookup_value} mono />
        {/* Populated once v3 has a device registry — see device_lookup_expr. */}
        <Meta label="Resolved device" value={d.resolved_device_id} mono />
      </dl>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="!h-3.5 !w-3.5" /> Loading payloads…
        </div>
      ) : (
        <>
          <div>
            <FieldLabel>Sent payload</FieldLabel>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-field bg-card px-3 py-2 font-mono text-[11px] text-foreground">
              {d?.raw_payload ? JSON.stringify(d.raw_payload, null, 2) : "—"}
              {d?.raw_truncated ? "\n… (truncated)" : ""}
            </pre>
          </div>
          <div>
            <FieldLabel>Transformed payload</FieldLabel>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-field bg-card px-3 py-2 font-mono text-[11px] text-foreground">
              {d?.transformed_payload ? JSON.stringify(d.transformed_payload, null, 2) : "—"}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
