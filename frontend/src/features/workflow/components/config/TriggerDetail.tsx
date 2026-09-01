"use client";

// Read-only detail pane for a trigger (right side of the Triggers master-detail).
// Header (name + enabled badge + edit/delete) over the event match, target SOP,
// conditions, dedup, and fire stats.
import { Icon } from "@iconify/react";
import { titleize, fmtRelative } from "@/lib/format";
import { OP_LABEL } from "../../lib/matcher";

export default function TriggerDetail({ trigger, sopName, onEdit, onDelete, onToggle, toggling, onTest }: any) {
  const t = trigger;
  const enabled = t.enabled !== false;
  const conds = Array.isArray(t.conditions) ? t.conditions : [];
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[rgba(251,191,36,.10)] text-nb-warn shrink-0">
            <Icon icon="heroicons:bolt" className="text-lg" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-nb-ink truncate">{t.name}</h2>
              <button
                type="button"
                onClick={onToggle}
                disabled={toggling}
                title={enabled ? "Click to disable" : "Click to enable"}
                className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium transition hover:opacity-80 disabled:opacity-50 ${enabled ? "bg-[rgba(52,211,153,.10)] text-nb-good" : "bg-[rgba(96,165,250,.1)] text-nb-faint"}`}
              >
                {enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <p className="mt-0.5 text-[11px] text-nb-faint font-mono">
              {t.event_source ? `${t.event_source}:` : ""}{t.event_type || "any"} → {sopName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onTest && (
            <button onClick={onTest} title="Test trigger" className="inline-flex items-center gap-1 rounded-md border border-nb-line px-2.5 py-1.5 text-xs text-nb-ink hover:bg-[rgba(96,165,250,.1)]">
              <Icon icon="heroicons-outline:beaker" className="text-sm" /> Test
            </button>
          )}
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-nb-line px-2.5 py-1.5 text-xs text-nb-ink hover:bg-[rgba(96,165,250,.1)]">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-[rgba(248,113,113,.30)] bg-[rgba(248,113,113,.10)] px-2.5 py-1.5 text-xs text-nb-crit hover:bg-[rgba(248,113,113,.20)]">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
        <Section title="Event match">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <Row label="Event source" value={t.event_source || "—"} mono />
            <Row label="Event type" value={t.event_type || "any"} mono />
            <Row label="Target SOP" value={sopName} />
            <Row label="Priority override" value={t.priority ? titleize(t.priority) : "Use SOP default"} />
          </div>
        </Section>

        <Section title={`Conditions (${conds.length})`}>
          {conds.length === 0 ? (
            <p className="text-sm text-nb-faint">No conditions — fires on any matching event type.</p>
          ) : (
            <ul className="rounded-lg border border-nb-line divide-y divide-nb-line">
              {conds.map((c, i) => (
                <li key={i} className="px-3 py-2 text-xs font-mono text-nb-ink flex items-center gap-2 flex-wrap">
                  <span className="text-nb-faint">{c.path || c.field}</span>
                  <span className="rounded-sm bg-[rgba(96,165,250,.1)] px-1.5 py-0.5 text-[10px] text-nb-faint">{OP_LABEL[c.op || c.operator] || c.op || c.operator}</span>
                  <span>{c.value == null ? "—" : String(c.value)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {t.dedup && (
          <Section title="Deduplication">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
              <Row label="Strategy" value={titleize(t.dedup.strategy)} />
              {t.dedup.key_field && <Row label="Key field" value={t.dedup.key_field} mono />}
              <Row label="Window" value={t.dedup.window_seconds != null ? `${t.dedup.window_seconds}s` : "—"} />
            </div>
          </Section>
        )}

        <Section title="Activity">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <Row label="Fire count" value={String(t.fire_count ?? 0)} />
            <Row label="Last fired" value={fmtRelative(t.last_fired_at)} />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: any) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-nb-faint">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, mono }: any) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-nb-faint/70">{label}</div>
      <div className={`text-sm text-nb-ink ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
