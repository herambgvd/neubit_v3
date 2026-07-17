"use client";

// Dry-run tester — runs the sample through the exact receiver pipeline (schema →
// rule match → transform → device lookup) and reports what would happen, without
// publishing or writing an event log.
//
// `would_publish` is the headline, not `schema_valid`: a webhook with rules
// rejects a payload none of them match, and that payload's schema is perfectly
// valid. Reporting only "Schema: Valid" there would be actively misleading.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { OUTCOME_PILL } from "../constants";

function ResultSection({ title, pill, pillOk, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {pill ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${pillOk ? OUTCOME_PILL.ok : OUTCOME_PILL.failed}`}>
            {pill}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ErrorList({ errors }) {
  if (!Array.isArray(errors) || !errors.length) return null;
  return (
    <ul className="list-inside list-disc space-y-0.5 font-mono text-[11px] text-red-500">
      {errors.map((er, i) => (
        <li key={i}>{typeof er === "string" ? er : JSON.stringify(er)}</li>
      ))}
    </ul>
  );
}

export default function WebhookTestPanel({ webhook, hookId }) {
  const [sample, setSample] = useState('{\n  "event": {\n    "name": "Door forced",\n    "severity": "high"\n  }\n}');
  const [jsonErr, setJsonErr] = useState("");

  const run = useMutation({
    mutationFn: (payload) => ingestApi.webhooks.test(hookId, payload),
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    let payload;
    try {
      payload = JSON.parse(sample);
    } catch {
      setJsonErr("Sample must be valid JSON");
      return;
    }
    setJsonErr("");
    run.mutate(payload);
  }

  const res = run.data;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Input */}
      <div className="space-y-3">
        <Field
          as="textarea"
          label="Sample payload (JSON)"
          rows={16}
          value={sample}
          onChange={(e) => {
            setSample(e.target.value);
            if (jsonErr) setJsonErr("");
          }}
          className="font-mono"
          error={jsonErr}
          hint="Validated against the schema, matched against the event rules, and transformed — but nothing is published and no event log row is written."
        />
        <div className="flex justify-end">
          <Button onClick={submit} disabled={run.isPending} icon="heroicons-outline:play" className="!px-3 !py-1.5 text-xs">
            {run.isPending ? "Running…" : "Run test"}
          </Button>
        </div>
      </div>

      {/* Result */}
      <div className="space-y-4 rounded-lg border border-card-border bg-hover/30 p-4">
        {!res ? (
          <p className="py-8 text-center text-xs text-muted">
            Run a test to see validation + transform output.
          </p>
        ) : (
          <>
            {/* Verdict */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  res.would_publish
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
                    : "border-red-500/20 bg-red-500/10 text-red-500"
                }`}
              >
                {res.would_publish ? "Would publish" : "Would NOT publish"}
              </span>
              {res.resolved_event_type && (
                <span className="font-mono text-[11px] text-muted">
                  as {res.resolved_event_type}
                </span>
              )}
            </div>
            {res.reject_reason && (
              <p className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500">
                {res.reject_reason}
              </p>
            )}
            {res.matched_rule_name && (
              <p className="text-[11px] text-muted">
                Matched rule: <span className="font-mono text-foreground">{res.matched_rule_name}</span>
              </p>
            )}

            <ResultSection
              title="Schema validation"
              pill={res.schema_valid ? "Passed" : `${res.schema_errors?.length || 0} error(s)`}
              pillOk={res.schema_valid}
            >
              <ErrorList errors={res.schema_errors} />
            </ResultSection>

            <ResultSection
              title="Transform"
              pill={res.transform_errors?.length ? `${res.transform_errors.length} error(s)` : "OK"}
              pillOk={!res.transform_errors?.length}
            >
              <ErrorList errors={res.transform_errors} />
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-field bg-card px-3 py-2 font-mono text-[11px] text-foreground">
                {res.transformed !== undefined && res.transformed !== null
                  ? JSON.stringify(res.transformed, null, 2)
                  : "—"}
              </pre>
            </ResultSection>

            {/* Device lookup — only when the webhook configures one (v2 parity). */}
            {webhook?.device_lookup_expr && (
              <ResultSection
                title="Device lookup"
                pill={res.device_lookup_value ? "Found value" : "No value"}
                pillOk={!!res.device_lookup_value}
              >
                <dl className="space-y-1 text-[11px]">
                  <div className="flex gap-2">
                    <dt className="text-muted">Looked up value:</dt>
                    <dd className="font-mono text-foreground">{res.device_lookup_value || "—"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted">Device id:</dt>
                    <dd className="font-mono text-foreground">
                      {res.resolved_device_id || "— (no device registry yet)"}
                    </dd>
                  </div>
                </dl>
              </ResultSection>
            )}

            {res.would_publish_subject && (
              <p className="truncate font-mono text-[11px] text-muted" title={res.would_publish_subject}>
                → {res.would_publish_subject}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
