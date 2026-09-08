"use client";

// Right-pane detail for a selected linkage rule: header (trigger icon, name,
// trigger/status pills, active toggle + close/edit/delete) and a read-only body —
// trigger/scope/cooldown grid, the configured actions, and WHETHER IT HAS EVER
// FIRED.
//
// That last part is the difference between a rule and a wish. The engine writes a
// fire-audit row for every match (rule, trigger, camera, what each action
// returned) and the API has served it all along on /vms/linkage-fires — no screen
// read it, so an operator could configure automation and had no way to tell
// whether it ever ran, or whether the recorder refused the action when it did.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { vms } from "../api";
import { EVENT_TYPE_PRESETS, LINKAGE_ACTION_TYPES, presetFor } from "../constants";
import type { LinkageRulePublic } from "../types";
import type { LinkageScopeDict } from "./LinkageRuleModal";

const actionLabel = (t: string) => LINKAGE_ACTION_TYPES.find((a) => a.value === t)?.label || t;

function scopeLabel(scope: LinkageScopeDict | null | undefined = {}) {
  if (!scope || scope.all || Object.keys(scope).length === 0) return "Any camera";
  if (Array.isArray(scope.camera_ids) && scope.camera_ids.length)
    return `${scope.camera_ids.length} camera${scope.camera_ids.length === 1 ? "" : "s"}`;
  if (Array.isArray(scope.group_ids) && scope.group_ids.length)
    return `${scope.group_ids.length} group${scope.group_ids.length === 1 ? "" : "s"}`;
  return "Any camera";
}

function InfoField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">{label}</div>
      <div className="mt-1 text-sm text-nb-ink">{children}</div>
    </div>
  );
}

export interface LinkageRuleDetailProps {
  rule: LinkageRulePublic;
  onToggle: (active: boolean) => void;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function LinkageRuleDetail({ rule, onToggle, onClose, onEdit, onDelete }: LinkageRuleDetailProps) {
  const tp = presetFor(EVENT_TYPE_PRESETS, rule.trigger_event_type, EVENT_TYPE_PRESETS.system);
  const actions = rule.actions || [];

  // The last few fires of THIS rule. Ten, not a page: this pane answers "is it
  // working", and the full trail is an audit question, not a config one.
  const firesQ = useQuery({
    queryKey: ["vms-linkage-fires", rule.id],
    queryFn: () => vms.linkage.fires({ rule_id: rule.id, limit: 10 }),
    refetchInterval: 30_000,
  });
  const fires = firesQ.data?.items || [];
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span className={`flex h-12 w-12 items-center justify-center rounded-xl border ${tp.cls}`}>
            <Icon icon={tp.icon} className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{rule.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-soft flex-wrap">
              <span>on {tp.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  rule.is_active ? "bg-[rgba(52,211,153,.12)] text-nb-good" : "border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted"
                }`}
              >
                {rule.is_active ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle checked={rule.is_active} onChange={(v) => onToggle(v)} label="Rule active" />
          <button
            onClick={onClose}
            title="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          <button
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1.5 text-xs text-nb-muted hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-[8px] border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-nb-crit hover:bg-red-500/20"
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
          <div className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted mb-2">Actions</div>
          {actions.length === 0 ? (
            <p className="text-sm text-nb-soft">No actions configured.</p>
          ) : (
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] px-3 py-2"
                >
                  <Icon icon="heroicons-outline:bolt" className="text-base text-nb-muted shrink-0" />
                  <span className="text-sm text-nb-ink">{actionLabel(a.type)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">
              Recent fires
            </span>
            {fires.length > 0 && (
              <span className="font-mono text-[11px] text-nb-faint">
                last {fmtRelative(fires[0].fired_at)}
              </span>
            )}
          </div>
          {firesQ.isLoading ? (
            <p className="text-sm text-nb-soft">Reading…</p>
          ) : firesQ.isError ? (
            <p className="text-sm text-nb-warn">{apiError(firesQ.error, "Couldn't read the fire log")}</p>
          ) : fires.length === 0 ? (
            // NOT "never fired": a rule armed this morning has not fired yet, and
            // one that has been armed for a month has a problem. The wording says
            // what is known and no more.
            <p className="text-sm text-nb-soft">
              No fires recorded yet.{" "}
              {rule.is_active
                ? "It fires when a matching event arrives."
                : "It is inactive, so it cannot fire."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {fires.map((f) => {
                const results = Array.isArray(f.actions_result) ? f.actions_result : [];
                const failed = results.filter((r) => (r as { ok?: boolean }).ok === false);
                return (
                  <li
                    key={f.id}
                    className="flex items-center gap-3 rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] px-3 py-2"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        failed.length ? "bg-nb-crit shadow-[0_0_5px_#f87171]" : "bg-nb-good shadow-[0_0_5px_#34d399]"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-nb-ink">
                        {f.camera_id || f.door_ref || f.trigger_event_type}
                      </span>
                      {/* An action that FAILED is the reason this list exists: the
                          rule matched and the recorder or the camera refused. */}
                      {failed.length > 0 && (
                        <span className="block truncate text-[11px] text-nb-crit">
                          {failed
                            .map((r) => {
                              const row = r as { type?: string; detail?: string };
                              return `${row.type || "action"}: ${row.detail || "failed"}`;
                            })
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-nb-faint">
                      {fmtRelative(f.fired_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
