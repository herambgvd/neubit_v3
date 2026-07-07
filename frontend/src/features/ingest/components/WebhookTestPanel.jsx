"use client";

// Dry-run tester — validate + transform a sample payload (no publish, no log).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { OUTCOME_PILL } from "../constants";

export default function WebhookTestPanel({ hookId }) {
  const [sample, setSample] = useState('{\n  "event": {\n    "name": "Door forced",\n    "severity": "high"\n  }\n}');
  const [jsonErr, setJsonErr] = useState("");

  const run = useMutation({
    mutationFn: (payload) => ingestApi.webhooks.test(hookId, payload),
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    let payload;
    try { payload = JSON.parse(sample); }
    catch { setJsonErr("Sample must be valid JSON"); return; }
    setJsonErr("");
    run.mutate(payload);
  }

  const res = run.data;
  return (
    <div className="space-y-4">
      <Field
        as="textarea"
        label="Sample payload (JSON)"
        rows={7}
        value={sample}
        onChange={(e) => { setSample(e.target.value); if (jsonErr) setJsonErr(""); }}
        className="font-mono"
        error={jsonErr}
        hint="Runs schema validation + JMESPath transform. Nothing is published or logged."
      />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={run.isPending} icon="heroicons-outline:play" className="!px-3 !py-1.5 text-xs">
          {run.isPending ? "Running…" : "Run test"}
        </Button>
      </div>

      {res && (
        <div className="space-y-3 rounded-lg border border-card-border bg-hover/30 p-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Schema</span>
            <span className={`text-[11px] rounded-full px-2 py-0.5 font-medium ${res.schema_valid ? OUTCOME_PILL.ok : OUTCOME_PILL.failed}`}>
              {res.schema_valid ? "Valid" : "Invalid"}
            </span>
            {res.would_publish_subject && (
              <span className="ml-auto text-[11px] font-mono text-muted truncate">→ {res.would_publish_subject}</span>
            )}
          </div>
          {Array.isArray(res.schema_errors) && res.schema_errors.length > 0 && (
            <ul className="text-xs text-red-500 list-disc list-inside space-y-0.5">
              {res.schema_errors.map((er, i) => <li key={i}>{typeof er === "string" ? er : JSON.stringify(er)}</li>)}
            </ul>
          )}
          {Array.isArray(res.transform_errors) && res.transform_errors.length > 0 && (
            <ul className="text-xs text-red-500 list-disc list-inside space-y-0.5">
              {res.transform_errors.map((er, i) => <li key={i}>{typeof er === "string" ? er : JSON.stringify(er)}</li>)}
            </ul>
          )}
          <div>
            <FieldLabel>Transformed output</FieldLabel>
            <pre className="mt-1 rounded-lg border border-field bg-card px-3 py-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all max-h-52 overflow-auto">
              {res.transformed !== undefined && res.transformed !== null ? JSON.stringify(res.transformed, null, 2) : "—"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
