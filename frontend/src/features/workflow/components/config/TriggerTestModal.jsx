"use client";

// Test a single trigger against a synthetic event. Enters an event_type +
// sample JSON payload, runs it through the real backend matcher via
// wfApi.simulate({ ..., dry_run:true }), then reports whether THIS trigger
// appears in matched_triggers (would fire) or in skipped (with reason).
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Modal, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "../../api";

const SAMPLE_PAYLOAD = JSON.stringify(
  { device_id: "cam-42", device: { zone_type: "secure" }, priority: 4 },
  null,
  2,
);

export default function TriggerTestModal({ open, trigger, onClose }) {
  const [eventType, setEventType] = useState("");
  const [payloadText, setPayloadText] = useState(SAMPLE_PAYLOAD);
  const [parseError, setParseError] = useState(null);
  const [result, setResult] = useState(null);

  const trigId = trigger?.trigger_id || trigger?.id;

  // Seed the event_type from the trigger each time the modal opens.
  useEffect(() => {
    if (open) {
      setEventType(trigger?.event_type && trigger.event_type !== "*" ? trigger.event_type : "");
      setPayloadText(SAMPLE_PAYLOAD);
      setParseError(null);
      setResult(null);
    }
  }, [open, trigger]);

  const run = useMutation({
    mutationFn: (body) => wfApi.simulate(body),
    onSuccess: (data) => setResult(data),
  });

  function submit() {
    setParseError(null);
    setResult(null);
    let payload = {};
    if (payloadText.trim()) {
      try {
        payload = JSON.parse(payloadText);
      } catch (e) {
        setParseError(e.message || "Invalid JSON");
        return;
      }
    }
    run.mutate({ event_type: eventType.trim() || trigger?.event_type || "*", payload, dry_run: true });
  }

  // Locate THIS trigger in the simulate response.
  const matched = result?.matched_triggers?.find((t) => t.trigger_id === trigId);
  const skipped = result?.skipped?.find((s) => s.trigger_id === trigId);
  const verdict = matched
    ? matched.would_create
      ? { tone: "ok", text: "Matched — this trigger would fire and raise an incident." }
      : { tone: "warn", text: "Matched, but no incident would be created (see reason below)." }
    : { tone: "bad", text: "No match — this trigger would NOT fire for this event." };

  const toneCls = {
    ok: "border-green-500/40 bg-green-500/10 text-green-500",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    bad: "border-red-500/40 bg-red-500/10 text-red-500",
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Test trigger${trigger?.name ? ` — ${trigger.name}` : ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="!px-3 !py-1.5 text-xs">Close</Button>
          <Button onClick={submit} disabled={run.isPending} icon="heroicons-outline:beaker" className="!px-3 !py-1.5 text-xs">
            {run.isPending ? "Running…" : "Run simulation"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Injects a synthetic event through the real matching pipeline (dry-run — nothing is persisted).
        </p>

        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted">Event type</label>
          <input
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="e.g. fire.alarm"
            className="mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm font-mono text-foreground outline-none focus:border-muted"
          />
        </div>

        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted">Sample payload (JSON)</label>
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            spellCheck={false}
            className="mt-1 h-52 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-muted"
          />
          {parseError && <p className="mt-1 text-xs text-red-500">JSON error: {parseError}</p>}
        </div>

        {run.isError && (
          <p className="text-xs text-red-500 flex items-center gap-1.5">
            <Icon icon="heroicons-outline:exclamation-triangle" /> {apiError(run.error)}
          </p>
        )}

        {run.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Simulating…</div>
        )}

        {result && !run.isPending && (
          <div className="space-y-3">
            <div className={`rounded-lg border px-3 py-2 text-sm font-medium ${toneCls[verdict.tone]}`}>
              {verdict.text}
            </div>
            {(matched || skipped) && (
              <ul className="space-y-1.5 text-xs">
                {matched && (
                  <li className="rounded-md border border-card-border bg-hover/40 px-3 py-2 text-muted">
                    <span className="font-mono text-foreground">would_create</span>: {String(matched.would_create)}
                  </li>
                )}
                {skipped && (
                  <li className="rounded-md border border-card-border bg-hover/40 px-3 py-2 text-muted">
                    <span className="font-mono text-foreground">reason</span>: {skipped.reason}
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
