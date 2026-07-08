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
            <div className="text-sm font-semibold text-foreground truncate">{s.name}</div>
            <div className="text-[11px] text-muted">{flags.join(" · ") || "—"}</div>
          </div>
        </div>
        {s.description ? (
          <p className="text-xs text-muted leading-relaxed">{s.description}</p>
        ) : (
          <p className="text-xs text-muted/70">No description.</p>
        )}
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {flags.map((f) => (
              <span key={f} className="rounded-full bg-hover px-2 py-0.5 text-[10px] font-medium text-muted">{f}</span>
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
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-amber-500/10 text-amber-500 shrink-0">
          <Icon icon="heroicons:bolt" className="text-base" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">{t.label || "Transition"}</div>
          <div className="text-[11px] font-mono text-muted truncate">
            {stateName(t.from_state_id)} → {stateName(t.to_state_id)}
          </div>
        </div>
      </div>
      {t.description ? (
        <p className="text-xs text-muted leading-relaxed">{t.description}</p>
      ) : (
        <p className="text-xs text-muted/70">No description.</p>
      )}
      <Row label="Requires note" value={t.requires_note ? "Yes" : "No"} />
      <Row label="Confirmation" value={t.confirmation_required ? "Required" : "No"} />
      <Row label="Form" value={t.form_config?.form_id || t.form_id ? "Linked" : "—"} />
    </Shell>
  );
}

function Shell({ title, onClose, onEdit, onDelete, children }) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between border-b border-card-border px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </header>
      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto px-4 py-4">{children}</div>
      {(onEdit || onDelete) && (
        <footer className="flex items-center justify-end gap-2 border-t border-card-border px-4 py-3">
          {onEdit && (
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
            >
              <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20"
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
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted/70">{label}</span>
      <span className="truncate text-muted">{value}</span>
    </div>
  );
}
