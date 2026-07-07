"use client";

// SOP state-machine strip on the incident detail — renders the ordered states as
// chips with the current one highlighted and initial/terminal markers. Read-only
// (the editable canvas lives in sop-designer/).
import { Icon } from "@iconify/react";

// Normalise id/name accessors across possible backend field names.
export const stateId = (s) => s?.id ?? s?.state_id;
export const stateName = (s) => s?.name ?? s?.state_name;

export default function StateMachine({ states, transitions, currentStateId, currentStateName }) {
  const isCurrent = (s) =>
    stateId(s) === currentStateId || stateName(s) === currentStateName;

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="px-5 py-4 border-b border-card-border">
        <h3 className="text-sm font-semibold text-foreground">State machine</h3>
        <p className="text-xs text-muted mt-0.5">
          {states.length} state(s) · {transitions.length} transition(s)
        </p>
      </header>
      <div className="px-5 py-5">
        {states.length === 0 ? (
          <p className="text-sm text-muted">SOP definition not available.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {states.map((s, i) => {
              const cur = isCurrent(s);
              return (
                <span key={stateId(s) ?? i} className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                      cur
                        ? "border-blue-500 bg-blue-500/10 text-blue-500"
                        : s.is_terminal
                          ? "border-card-border bg-hover text-muted"
                          : "border-card-border bg-transparent text-foreground"
                    }`}
                  >
                    {s.is_entry_point && <Icon icon="heroicons-outline:play" className="text-xs" />}
                    {stateName(s)}
                    {s.is_terminal && <Icon icon="heroicons-outline:flag" className="text-xs" />}
                    {cur && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />}
                  </span>
                  {i < states.length - 1 && (
                    <Icon icon="heroicons-outline:chevron-right" className="text-muted text-base shrink-0" />
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
