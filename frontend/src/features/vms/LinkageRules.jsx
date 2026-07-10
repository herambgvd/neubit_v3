"use client";

// VMS → Linkage (P5-C). The event-automation surface: linkage rules that fire
// actions (record / notify / PTZ / output / popup) when a matching camera event
// arrives. A rule list with an active toggle + trigger/scope/action summary, an
// editor modal (LinkageRuleModal), and delete. CRUD via vms.linkage.
//
// Lives under Config → Linkage.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, EmptyState, MetricRow, PageHeader, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import { EVENT_TYPE_PRESETS, LINKAGE_ACTION_TYPES } from "./constants";
import LinkageRuleModal from "./components/LinkageRuleModal";

const actionLabel = (t) => LINKAGE_ACTION_TYPES.find((a) => a.value === t)?.label || t;

function scopeLabel(scope = {}) {
  if (!scope || scope.all || Object.keys(scope).length === 0) return "Any camera";
  if (Array.isArray(scope.camera_ids) && scope.camera_ids.length)
    return `${scope.camera_ids.length} camera${scope.camera_ids.length === 1 ? "" : "s"}`;
  if (Array.isArray(scope.group_ids) && scope.group_ids.length)
    return `${scope.group_ids.length} group${scope.group_ids.length === 1 ? "" : "s"}`;
  return "Any camera";
}

export default function LinkageRulesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [saveError, setSaveError] = useState(null);
  const [confirm, setConfirm] = useState(null); // { rule } or null

  const q = useQuery({
    queryKey: ["vms-linkage-rules"],
    queryFn: () => vms.linkage.list({ limit: 200 }),
  });
  const rules = useMemo(() => asItems(q.data), [q.data]);

  const saveMut = useMutation({
    mutationFn: ({ id, body }) => (id ? vms.linkage.update(id, body) : vms.linkage.create(body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] });
      toast.success("Rule saved");
      setEditing(undefined);
      setSaveError(null);
    },
    onError: (e) => setSaveError(apiError(e, "Failed to save rule")),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }) => vms.linkage.update(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] }),
    onError: (e) => toast.error(apiError(e, "Failed to update rule")),
  });

  const delMut = useMutation({
    mutationFn: (id) => vms.linkage.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] });
      toast.success("Rule deleted");
      setConfirm(null);
    },
    onError: (e) => toast.error(apiError(e, "Failed to delete rule")),
  });

  const openNew = () => {
    setSaveError(null);
    setEditing(null);
  };

  return (
    <div className="pb-8">
      <PageHeader
        title="Linkage rules"
        subtitle="Automate actions from camera events — record, notify, PTZ, output, or pop the camera for an operator."
        actions={
          <Button icon="heroicons-outline:plus" onClick={openNew}>
            New rule
          </Button>
        }
      />

      {q.isLoading ? (
        <div className="flex items-center gap-2 p-6 text-xs text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading rules…
        </div>
      ) : q.isError ? (
        <div className="m-1 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <Icon icon="heroicons-outline:exclamation-circle" className="mt-0.5 shrink-0 text-sm" />
          <div>
            <p className="font-medium">Failed to load rules</p>
            <p className="mt-0.5 text-[11px] opacity-80">{apiError(q.error, "Unknown error")}</p>
          </div>
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon="heroicons-outline:bolt"
          title="No linkage rules yet"
          subtitle="Create a rule to react to camera events — e.g. start a clip on motion, or pop the camera when a zone is breached."
          action={
            <Button icon="heroicons-outline:plus" onClick={openNew}>
              New rule
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <MetricRow
            items={[
              { label: "Rules", value: rules.length, icon: "heroicons-outline:bolt", tone: "info" },
              { label: "Active", value: rules.filter((r) => r.is_active).length, icon: "heroicons-outline:play", tone: "ok" },
              { label: "Inactive", value: rules.filter((r) => !r.is_active).length, icon: "heroicons-outline:pause", tone: "neutral" },
            ]}
          />
          <div className="space-y-2">
          {rules.map((rule) => {
            const tp = EVENT_TYPE_PRESETS[rule.trigger_event_type] || EVENT_TYPE_PRESETS.system;
            return (
              <div
                key={rule.id}
                className="flex items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${tp.cls}`}>
                  <Icon icon={tp.icon} className="text-base" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{rule.name}</span>
                    {!rule.is_active && (
                      <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">Inactive</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                    <span>on {tp.label}</span>
                    <span className="opacity-40">·</span>
                    <span>{scopeLabel(rule.camera_scope)}</span>
                    <span className="opacity-40">·</span>
                    <span className="inline-flex items-center gap-1">
                      <Icon icon="heroicons-outline:bolt" className="text-[11px]" />
                      {(rule.actions || []).length
                        ? (rule.actions || []).map((a) => actionLabel(a.type)).join(", ")
                        : "no actions"}
                    </span>
                    {rule.cooldown_seconds > 0 && (
                      <>
                        <span className="opacity-40">·</span>
                        <span>cooldown {rule.cooldown_seconds}s</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Toggle
                    checked={rule.is_active}
                    onChange={(v) => toggleMut.mutate({ id: rule.id, is_active: v })}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setSaveError(null);
                      setEditing(rule);
                    }}
                    title="Edit"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted hover:bg-hover hover:text-foreground"
                  >
                    <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirm({ rule })}
                    title="Delete"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted hover:bg-hover hover:text-red-500"
                  >
                    <Icon icon="heroicons-outline:trash" className="text-sm" />
                  </button>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      )}

      <LinkageRuleModal
        open={editing !== undefined}
        rule={editing || null}
        onClose={() => {
          setEditing(undefined);
          setSaveError(null);
        }}
        onSave={(body) => saveMut.mutate({ id: editing?.id, body })}
        saving={saveMut.isPending}
        error={saveError}
      />

      <ConfirmDialog
        state={
          confirm
            ? {
                title: "Delete linkage rule",
                message: `Delete "${confirm.rule.name}"? This can't be undone.`,
                confirmLabel: "Delete",
                tone: "danger",
                onConfirm: () => delMut.mutate(confirm.rule.id),
              }
            : null
        }
        onClose={() => setConfirm(null)}
        pending={delMut.isPending}
      />
    </div>
  );
}
