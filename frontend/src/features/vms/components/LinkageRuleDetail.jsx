"use client";

// Right-pane detail for a selected linkage rule: header (trigger icon, name,
// trigger/status pills, active toggle + close/edit/delete) and a read-only body —
// trigger/scope/cooldown grid plus the configured actions. Mirrors SiteDetail.
import { Icon } from "@iconify/react";
import { Toggle } from "@/components/ui/kit";
import { EVENT_TYPE_PRESETS, LINKAGE_ACTION_TYPES } from "../constants";

const actionLabel = (t) => LINKAGE_ACTION_TYPES.find((a) => a.value === t)?.label || t;

function scopeLabel(scope = {}) {
  if (!scope || scope.all || Object.keys(scope).length === 0) return "Any camera";
  if (Array.isArray(scope.camera_ids) && scope.camera_ids.length)
    return `${scope.camera_ids.length} camera${scope.camera_ids.length === 1 ? "" : "s"}`;
  if (Array.isArray(scope.group_ids) && scope.group_ids.length)
    return `${scope.group_ids.length} group${scope.group_ids.length === 1 ? "" : "s"}`;
  return "Any camera";
}

function InfoField({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function LinkageRuleDetail({ rule, onToggle, onClose, onEdit, onDelete }) {
  const tp = EVENT_TYPE_PRESETS[rule.trigger_event_type] || EVENT_TYPE_PRESETS.system;
  const actions = rule.actions || [];
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className={`flex h-12 w-12 items-center justify-center rounded-xl border ${tp.cls}`}>
            <Icon icon={tp.icon} className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{rule.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted flex-wrap">
              <span>on {tp.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  rule.is_active ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
                }`}
              >
                {rule.is_active ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle checked={rule.is_active} onChange={(v) => onToggle(v)} />
          <button
            onClick={onClose}
            title="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          <button
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
          >
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20"
          >
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <InfoField label="Trigger event">{tp.label}</InfoField>
          <InfoField label="Camera scope">{scopeLabel(rule.camera_scope)}</InfoField>
          <InfoField label="Cooldown">{rule.cooldown_seconds > 0 ? `${rule.cooldown_seconds}s` : "None"}</InfoField>
          <InfoField label="Status">{rule.is_active ? "Active" : "Inactive"}</InfoField>
        </div>

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Actions</div>
          {actions.length === 0 ? (
            <p className="text-sm text-muted">No actions configured.</p>
          ) : (
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-card-border bg-hover/40 px-3 py-2"
                >
                  <Icon icon="heroicons-outline:bolt" className="text-base text-muted shrink-0" />
                  <span className="text-sm text-foreground">{actionLabel(a.type)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
