"use client";

// Right-hand "Actions" aside — the SOP transitions leaving the current state,
// rendered as buttons. The status/assign/escalate/PDF controls now live in the
// unified IncidentActionBar; this panel is purely the state-machine moves.
// Presentational — the parent owns the transition mutation + pending flag.
import { Icon } from "@iconify/react";
import { Spinner } from "@/components/ui/kit";
import { titleize } from "@/lib/format";
import { stateId, stateName } from "./StateMachine";

export default function ManagePanel({
  currentStateName,
  states,
  allowed,
  transitionPending,
  sopLoading,
  onRunTransition,
}) {
  return (
    <aside className="space-y-4">
      <div className="rounded-xl border border-card-border bg-card p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Current state</div>
        <div className="mt-1 text-lg font-semibold text-foreground">{currentStateName || "—"}</div>
      </div>

      <div className="rounded-xl border border-card-border bg-card">
        <header className="px-5 py-4 border-b border-card-border">
          <h3 className="text-sm font-semibold text-foreground">Actions</h3>
          <p className="text-xs text-muted mt-0.5">Available transitions from the current state.</p>
        </header>
        <div className="px-5 py-4 space-y-2">
          {sopLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="!h-4 !w-4" /> Loading…
            </div>
          ) : allowed.length === 0 ? (
            <p className="text-sm text-muted">No transitions available (terminal state or SOP not loaded).</p>
          ) : (
            allowed.map((t) => {
              const to = t.to_state_name || stateName(states.find((s) => stateId(s) === (t.to_state_id ?? t.to_state))) || t.to_state;
              const formRef = t.form_id ?? t.form_config?.form_id;
              const hasForm = !!(t.form_config?.fields?.length || formRef);
              return (
                <button
                  key={t.id ?? t.transition_id ?? t.name}
                  onClick={() => onRunTransition(t)}
                  disabled={transitionPending}
                  className="w-full flex items-center justify-between gap-2 rounded-lg border border-card-border bg-transparent px-3 py-2.5 text-sm text-foreground hover:bg-hover transition disabled:opacity-50"
                >
                  <span className="flex flex-col text-left">
                    <span className="font-medium">{t.name || `→ ${titleize(to)}`}</span>
                    <span className="text-xs text-muted">to {titleize(to)}</span>
                  </span>
                  {hasForm && <Icon icon="heroicons-outline:document-text" className="text-base text-muted shrink-0" title="Requires a form" />}
                  <Icon icon="heroicons-outline:arrow-right" className="text-base text-muted shrink-0" />
                </button>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
