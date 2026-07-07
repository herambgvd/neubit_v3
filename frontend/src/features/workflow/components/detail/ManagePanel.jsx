"use client";

// Right-hand incident management aside: current-state card, Manage card
// (assignee select + status/escalate action buttons), and Actions card (allowed
// SOP transitions as buttons). Presentational — the parent owns the mutations and
// passes the handlers + pending flags.
import { Icon } from "@iconify/react";
import { Button, Spinner } from "@/components/ui/kit";
import { titleize } from "@/lib/format";
import { stateId, stateName } from "./StateMachine";

const userLabel = (u) => u?.full_name || u?.name || u?.email || u?.username || String(u?.id || "").slice(0, 8);

// Which status actions are offered from the current status.
export const STATUS_ACTIONS = {
  pending: [{ status: "active", label: "Activate", variant: "primary", reason: false }],
  active: [
    { status: "paused", label: "Pause", variant: "secondary", reason: false },
    { status: "resolved", label: "Resolve", variant: "success", reason: true },
    { status: "cancelled", label: "Cancel", variant: "danger", reason: true },
  ],
  paused: [
    { status: "active", label: "Resume", variant: "primary", reason: false },
    { status: "resolved", label: "Resolve", variant: "success", reason: true },
    { status: "cancelled", label: "Cancel", variant: "danger", reason: true },
  ],
};

export default function ManagePanel({
  instance,
  currentStateName,
  states,
  allowed,
  users = [],
  usersLoading,
  assignPending,
  actionPending,
  transitionPending,
  sopLoading,
  onAssign,
  onStatusAction,
  onEscalate,
  onRunTransition,
}) {
  const inst = instance;
  return (
    <aside className="space-y-4">
      <div className="rounded-xl border border-card-border bg-card p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Current state</div>
        <div className="mt-1 text-lg font-semibold text-foreground">{currentStateName || "—"}</div>
      </div>

      {/* Manage: assignment, escalation, status */}
      <div className="rounded-xl border border-card-border bg-card">
        <header className="px-5 py-4 border-b border-card-border">
          <h3 className="text-sm font-semibold text-foreground">Manage</h3>
        </header>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted">Assignee</label>
            <select
              value={inst.assigned_to ?? inst.assignee_id ?? ""}
              onChange={(e) => onAssign(e.target.value || null)}
              disabled={assignPending || usersLoading}
              className="mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted disabled:opacity-50"
            >
              <option value="" className="bg-card">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id} className="bg-card">{userLabel(u)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            {(STATUS_ACTIONS[inst.status] || []).map((a) => (
              <Button key={a.status} variant={a.variant} onClick={() => onStatusAction(a)} disabled={actionPending} className="!px-3 !py-1.5 text-xs">
                {a.label}
              </Button>
            ))}
            <Button variant="secondary" icon="heroicons-outline:arrow-trending-up" onClick={onEscalate} disabled={actionPending || inst.status === "resolved" || inst.status === "cancelled" || inst.status === "completed"} className="!px-3 !py-1.5 text-xs">
              Escalate
            </Button>
          </div>
        </div>
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
