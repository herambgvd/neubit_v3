"use client";

// Read-only detail pane for a trigger (right side of the Triggers master-detail).
// Header (name + enabled badge + edit/delete) over the event match, target SOP,
// conditions, dedup, and fire stats.
import { Icon } from "@iconify/react";
import { titleize, fmtRelative } from "@/lib/format";
import { OP_LABEL } from "../../lib/matcher";

export default function TriggerDetail({ trigger, sopName, onEdit, onDelete, onToggle, toggling, onTest }) {
  const t = trigger;
  const enabled = t.enabled !== false;
  const conds = Array.isArray(t.conditions) ? t.conditions : [];
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-amber-500/10 text-amber-500 shrink-0">
            <Icon icon="heroicons:bolt" className="text-lg" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground truncate">{t.name}</h2>
              <button
                type="button"
                onClick={onToggle}
                disabled={toggling}
                title={enabled ? "Click to disable" : "Click to enable"}
                className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium transition hover:opacity-80 disabled:opacity-50 ${enabled ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"}`}
              >
                {enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <p className="mt-0.5 text-[11px] text-muted font-mono">
              {t.event_source ? `${t.event_source}:` : ""}{t.event_type || "any"} → {sopName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onTest && (
            <button onClick={onTest} title="Test trigger" className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
              <Icon icon="heroicons-outline:beaker" className="text-sm" /> Test
            </button>
          )}
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
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
            <p className="text-sm text-muted">No conditions — fires on any matching event type.</p>
          ) : (
            <ul className="rounded-lg border border-card-border divide-y divide-card-border">
              {conds.map((c, i) => (
                <li key={i} className="px-3 py-2 text-xs font-mono text-foreground flex items-center gap-2 flex-wrap">
                  <span className="text-muted">{c.path || c.field}</span>
                  <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">{OP_LABEL[c.op || c.operator] || c.op || c.operator}</span>
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

function Section({ title, children }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted/70">{label}</div>
      <div className={`text-sm text-foreground ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
