"use client";

// Simulator tab — dry-run (or live) a synthetic event through trigger +
// alert-format matching, without needing a real device. Left: an event composer
// (event_type / alert_code / site / JSON payload / dry-run toggle + presets).
// Right: the match result (matched triggers → SOP, matched format, skipped
// reasons, and the created incident id when running live).
//
// The camera/access device pickers from neubit_v2's simulator are intentionally
// dropped — the VMS phase is deferred, so this uses a generic event_type + raw
// JSON payload instead.
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Badge, Spinner, checkboxClass } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, idOf } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { workflow as wfApi } from "../../api";

// Generic sample events — no device dependency. Each fills the composer fields.
const PRESETS = [
  {
    id: "motion",
    label: "Motion (custom)",
    icon: "heroicons-outline:eye",
    eventType: "motion",
    alertCode: "",
    payload: { source: "custom", severity: "medium", description: "Simulated motion event", zone: "perimeter" },
  },
  {
    id: "ingest",
    label: "Ingest event",
    icon: "heroicons-outline:inbox-arrow-down",
    eventType: "ingest.event",
    alertCode: "",
    payload: { source_service: "ingest", event_type: "ingest.event", severity: "high", data: { key: "value" } },
  },
  {
    id: "alert_code",
    label: "Alert code test",
    icon: "heroicons-outline:swatch",
    eventType: "alert",
    alertCode: "ALERT_PERIMETER",
    payload: { severity: "high", description: "Testing an alert-format match by code" },
  },
];

const SAMPLE_PAYLOAD = JSON.stringify({ severity: "medium", source: "custom" }, null, 2);

export default function SimulatorTab() {
  const sitesQ = useQuery({ queryKey: ["sim-sites"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const sites = asItems(sitesQ.data);

  const [eventType, setEventType] = useState("");
  const [alertCode, setAlertCode] = useState("");
  const [siteId, setSiteId] = useState("");
  const [payloadText, setPayloadText] = useState(SAMPLE_PAYLOAD);
  const [dryRun, setDryRun] = useState(true);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);

  function applyPreset(p) {
    setEventType(p.eventType);
    setAlertCode(p.alertCode || "");
    setPayloadText(JSON.stringify(p.payload, null, 2));
    setErrors({});
  }

  function parsePayload() {
    const t = payloadText.trim();
    if (!t) return {};
    return JSON.parse(t); // throws → caught in submit
  }

  const simulate = useMutation({
    mutationFn: (body) => wfApi.simulate(body),
    onSuccess: (res) => {
      setResult(res);
      if (!dryRun && (res?.created_instance_id || res?.created_instance_ids?.length)) {
        toast.success("Incident created");
      } else {
        toast.success("Simulation complete");
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!eventType.trim()) next.eventType = "Event type is required";
    let payload;
    try {
      payload = parsePayload();
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        next.payload = "Payload must be a JSON object";
      }
    } catch (err) {
      next.payload = `Invalid JSON: ${err.message}`;
    }
    if (Object.keys(next).length) { setErrors(next); return; }
    setErrors({});
    // Live run (dry-run OFF) creates a REAL incident + fires SOP actions from a
    // config screen — confirm before it happens.
    if (!dryRun && !window.confirm(
      "Run LIVE — this creates a real incident and fires the SOP's real actions " +
      "(notifications, linkage, etc). Continue?"
    )) {
      return;
    }
    simulate.mutate({
      event_type: eventType.trim(),
      payload,
      site_id: siteId || null,
      alert_code: alertCode.trim() || null,
      dry_run: dryRun,
    });
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-2">
      {/* ── Composer ─────────────────────────────────────────────── */}
      <form onSubmit={submit} className="flex min-h-0 flex-col rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)]">
        <header className="shrink-0 px-5 py-4 border-b border-nb-line">
          <h3 className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Event composer</h3>
          <p className="text-xs text-nb-faint">Compose a synthetic event and run it through trigger + format matching.</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-themed px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">Presets</label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1.5 text-xs font-medium text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
                >
                  <Icon icon={p.icon} className="text-sm" /> {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field
              label="Event type"
              required
              value={eventType}
              onChange={(e) => { setEventType(e.target.value); if (errors.eventType) setErrors((p) => ({ ...p, eventType: undefined })); }}
              placeholder="e.g. motion, fire.alarm"
              className="font-mono"
              error={errors.eventType}
            />
            <Field
              label="Alert code"
              value={alertCode}
              onChange={(e) => setAlertCode(e.target.value)}
              placeholder="Optional — match an alert format"
              className="font-mono"
            />
          </div>

          <Field
            as="select"
            label="Site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            options={[{ value: "", label: sitesQ.isLoading ? "Loading sites…" : "No site" }, ...sites.map((s) => ({ value: idOf(s, "site_id", "id"), label: s.name }))]}
          />

          <Field
            as="textarea"
            rows={8}
            label="Payload (JSON)"
            value={payloadText}
            onChange={(e) => { setPayloadText(e.target.value); if (errors.payload) setErrors((p) => ({ ...p, payload: undefined })); }}
            className="font-mono text-xs"
            placeholder='{ "severity": "high" }'
            error={errors.payload}
          />

          <label className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition ${dryRun ? "border-nb-line bg-[rgba(6,11,26,.5)]" : "border-nb-warn/40 bg-nb-warn/10"}`}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className={`${checkboxClass} mt-0.5`} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-nb-ink">Dry run</span>
              <span className="block text-[11px] text-nb-faint">
                {dryRun
                  ? "Match only — no incident is created."
                  : "Live — a matching format/trigger will create a REAL incident."}
              </span>
            </span>
          </label>

          <div className="flex items-center justify-end">
            <button type="submit" disabled={simulate.isPending} className={`inline-flex items-center gap-1.5 rounded-[9px] border px-3.5 py-2 text-sm tracking-[.4px] transition disabled:opacity-50 ${dryRun ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.14)] text-nb-blueb hover:bg-[rgba(96,165,250,.22)]" : "border-nb-crit/50 bg-nb-crit/10 text-nb-crit hover:shadow-[0_0_10px_rgba(248,113,113,.25)]"}`}>
              <Icon icon={dryRun ? "heroicons-outline:beaker" : "heroicons-outline:bolt"} className="text-sm" />
              {simulate.isPending ? "Simulating…" : dryRun ? "Simulate" : "Run live"}
            </button>
          </div>
        </div>
      </form>

      {/* ── Result ───────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)]">
        <header className="shrink-0 px-5 py-4 border-b border-nb-line flex items-center justify-between">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Result</h3>
            <p className="text-xs text-nb-faint">What the event matched.</p>
          </div>
          {result && (
            <Badge color={result.dry_run ? "blue" : "amber"}>{result.dry_run ? "Dry run" : "Live"}</Badge>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-themed px-5 py-4">
          {simulate.isPending ? (
            <div className="text-sm text-nb-faint flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Simulating…</div>
          ) : !result ? (
            <div className="py-10 text-center text-sm text-nb-faint">
              <Icon icon="heroicons-outline:beaker" className="mx-auto mb-2 text-2xl text-nb-faint/60" />
              Run a simulation to see matches.
            </div>
          ) : (
            <ResultPanel result={result} />
          )}
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ result }) {
  const triggers = result.matched_triggers || [];
  const skipped = result.skipped || [];
  const fmt = result.matched_format;
  const createdIds = result.created_instance_ids?.length
    ? result.created_instance_ids
    : result.created_instance_id
      ? [result.created_instance_id]
      : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-nb-faint font-mono">
        <span className="rounded-sm bg-[rgba(96,165,250,.1)] px-1.5 py-0.5">{result.event_type || "—"}</span>
        {result.alert_code && <span className="rounded-sm bg-[rgba(96,165,250,.1)] px-1.5 py-0.5">code: {result.alert_code}</span>}
      </div>

      {/* Matched triggers */}
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-nb-faint mb-1.5">Matched triggers ({triggers.length})</h4>
        {triggers.length === 0 ? (
          <p className="text-[11px] text-nb-faint/70">No triggers matched.</p>
        ) : (
          <ul className="rounded-lg border border-nb-line divide-y divide-nb-line">
            {triggers.map((t, i) => (
              <li key={t.trigger_id || i} className="flex items-center gap-2 px-3 py-2">
                <Icon icon="heroicons:bolt" className="text-nb-warn text-sm shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-nb-ink truncate">{t.name || t.trigger_id}</span>
                  {t.sop_id && <span className="block text-[11px] text-nb-faint font-mono truncate">→ SOP {t.sop_id}</span>}
                </span>
                {t.would_create ? (
                  <Icon icon="heroicons-solid:check-circle" className="text-nb-good text-base shrink-0" title="Would create" />
                ) : (
                  <Icon icon="heroicons-outline:minus-circle" className="text-nb-faint text-base shrink-0" title="Would not create" />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Matched format */}
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-nb-faint mb-1.5">Matched format</h4>
        {!fmt ? (
          <p className="text-[11px] text-nb-faint/70">No alert format matched.</p>
        ) : (
          <div className="rounded-lg border border-nb-line px-3 py-2.5 flex items-center gap-2">
            <Icon icon="heroicons-outline:swatch" className="text-nb-blueb text-base shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-nb-ink">{fmt.name || fmt.alert_code}</span>
                {fmt.sop_mode && <Badge color="blue">{fmt.sop_mode}</Badge>}
              </span>
              <span className="block text-[11px] text-nb-faint font-mono truncate">
                {fmt.alert_code}{fmt.sop_id ? ` → SOP ${fmt.sop_id}` : ""}
              </span>
            </span>
            {fmt.would_create ? (
              <Icon icon="heroicons-solid:check-circle" className="text-nb-good text-base shrink-0" title="Would create" />
            ) : (
              <Icon icon="heroicons-outline:minus-circle" className="text-nb-faint text-base shrink-0" title="Would not create" />
            )}
          </div>
        )}
      </section>

      {/* Skipped */}
      {skipped.length > 0 && (
        <section>
          <h4 className="text-xs font-medium uppercase tracking-wide text-nb-faint mb-1.5">Skipped ({skipped.length})</h4>
          <ul className="rounded-lg border border-nb-line divide-y divide-nb-line">
            {skipped.map((s, i) => (
              <li key={i} className="flex items-start gap-2 px-3 py-2">
                <Icon icon="heroicons-outline:no-symbol" className="text-nb-faint text-sm shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-nb-faint font-mono truncate">{s.trigger_id || s.format_id || "—"}</span>
                  <span className="block text-xs text-nb-ink">{s.reason || "Skipped"}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Created incident (live) */}
      {createdIds.length > 0 && (
        <section className="rounded-lg border border-[rgba(52,211,153,.30)] bg-[rgba(52,211,153,.10)] px-3 py-2.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-nb-good mb-1.5">Incident created</h4>
          <ul className="space-y-1">
            {createdIds.map((id) => (
              <li key={id}>
                <Link href={`/events/${id}`} className="inline-flex items-center gap-1.5 text-sm text-nb-ink hover:underline font-mono">
                  <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-sm" /> {id}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
