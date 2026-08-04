"use client";

// Right-hand side panel for the SOP designer — shows the currently selected
// state or transition as a w-72 card (header + close, body of fields, footer
// Edit + Delete). Replaces the old floating selection action-bar to match the
// v2 layout. Presentational: the parent (SopCanvas) supplies the selection, the
// resolved states/transitions, and the edit/delete/close handlers.
import { Icon } from "@iconify/react";
import { idOf } from "@/lib/format";

const sid = (s) => idOf(s, "state_id", "id");
const tid = (t) => idOf(t, "transition_id", "id");

export default function SopSidePanel({
  selection,
  states = [],
  transitions = [],
  onClose,
  onEdit,
  onDelete,
}) {
  if (!selection) return null;

  if (selection.kind === "state") {
    const s = states.find((x) => sid(x) === selection.id);
    if (!s) return null;
    const flags = [s.is_initial && "Initial", s.is_terminal && "Terminal", s.is_cancellation && "Cancellation"].filter(Boolean);
    return (
      <Shell title="State" onClose={onClose} onEdit={onEdit} onDelete={onDelete}>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-white shrink-0"
            style={{ background: s.color || "#6366F1" }}
          >
            <Icon icon="heroicons:rectangle-stack" className="text-base" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-nb-ink truncate">{s.name}</div>
            <div className="text-[11px] text-nb-muted">{flags.join(" · ") || "—"}</div>
          </div>
        </div>
        {s.description ? (
          <p className="text-xs text-nb-muted leading-relaxed">{s.description}</p>
        ) : (
          <p className="text-xs text-nb-muted/70">No description.</p>
        )}
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {flags.map((f) => (
              <span key={f} className="rounded-full bg-[rgba(96,165,250,.1)] px-2 py-0.5 text-[10px] font-medium text-nb-muted">{f}</span>
            ))}
          </div>
        )}
        <Row label="SLA" value={s.sla_hours != null ? `${s.sla_hours}h` : "—"} />
        <Row label="Position" value={`${Math.round(s.position_x ?? 0)}, ${Math.round(s.position_y ?? 0)}`} />
      </Shell>
    );
  }

  const t = transitions.find((x) => tid(x) === selection.id);
  if (!t) return null;
  const stateName = (id) => states.find((s) => sid(s) === id)?.name || "—";
  return (
    <Shell title="Transition" onClose={onClose} onEdit={onEdit} onDelete={onDelete}>
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[rgba(251,191,36,.10)] text-nb-warn shrink-0">
          <Icon icon="heroicons:bolt" className="text-base" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-nb-ink truncate">{t.label || "Transition"}</div>
          <div className="text-[11px] font-mono text-nb-muted truncate">
            {stateName(t.from_state_id)} → {stateName(t.to_state_id)}
          </div>
        </div>
      </div>
      {t.description ? (
        <p className="text-xs text-nb-muted leading-relaxed">{t.description}</p>
      ) : (
        <p className="text-xs text-nb-muted/70">No description.</p>
      )}
      <Row label="Requires note" value={t.requires_note ? "Yes" : "No"} />
      <Row label="Confirmation" value={t.confirmation_required ? "Required" : "No"} />
      <Row label="Form" value={t.form_config?.form_id || t.form_id ? "Linked" : "—"} />
    </Shell>
  );
}

function Shell({ title, onClose, onEdit, onDelete, children }) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)]">
      <header className="flex items-center justify-between border-b border-nb-line px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-nb-muted">{title}</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-nb-muted hover:bg-[rgba(96,165,250,.1)] hover:text-nb-ink"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </header>
      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto px-4 py-4">{children}</div>
      {(onEdit || onDelete) && (
        <footer className="flex items-center justify-end gap-2 border-t border-nb-line px-4 py-3">
          {onEdit && (
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-md border border-nb-line px-2.5 py-1.5 text-xs text-nb-ink hover:bg-[rgba(96,165,250,.1)]"
            >
              <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-md border border-[rgba(248,113,113,.30)] bg-[rgba(248,113,113,.10)] px-2.5 py-1.5 text-xs text-nb-crit hover:bg-[rgba(248,113,113,.20)]"
            >
              <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[10px] font-medium uppercase tracking-wide text-nb-muted/70">{label}</span>
      <span className="truncate text-nb-muted">{value}</span>
    </div>
  );
}
