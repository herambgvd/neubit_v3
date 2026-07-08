"use client";

// Per-webhook Event Rules — the "Rules" tab of the webhook detail modal.
// One webhook can recognise many event shapes: when a payload arrives, rules
// are checked in priority order (lower first); the first match decides which
// fields to extract and what event_type to tag the event as.
//
// Ported 1:1 from neubit_v2's ingest rules list (RuleRow / summarizeConditions),
// re-themed onto v3 shared components.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner, Badge } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import RuleFormModal from "./RuleFormModal";

export default function RulesPanel({ webhookId }) {
  const qc = useQueryClient();
  const key = ["ingest-event-rules", webhookId];
  const q = useQuery({ queryKey: key, queryFn: () => ingestApi.eventRules.list(webhookId) });
  const rules = asItems(q.data); // backend returns priority ASC

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const remove = useMutation({
    mutationFn: (id) => ingestApi.eventRules.remove(id),
    onSuccess: () => { toast.success("Rule deleted"); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => ingestApi.eventRules.update(id, { enabled }),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-muted/80 max-w-md">
          One webhook can recognise many event shapes. When a payload arrives, rules are checked in
          priority order (lower first); the first match decides which fields to extract and what
          event type to tag the event as.
        </p>
        <Button
          icon="heroicons-outline:plus"
          className="!px-3 !py-1.5 text-xs shrink-0"
          onClick={() => { setEditing(null); setFormOpen(true); }}
        >
          New rule
        </Button>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted">
          <Spinner className="!h-4 !w-4" /> Loading rules…
        </div>
      ) : rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-card-border py-10 text-center">
          <Icon icon="heroicons-outline:funnel" className="text-3xl text-muted mb-2 opacity-60" />
          <p className="text-sm font-medium text-foreground">No event rules yet</p>
          <p className="text-xs text-muted mt-1 max-w-sm">
            Without rules, the webhook uses its flat field map for every payload. Add rules to
            handle multiple event shapes from the same receiver URL.
          </p>
        </div>
      ) : (
        <ul className="rounded-lg border border-card-border divide-y divide-card-border">
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onEdit={() => { setEditing(r); setFormOpen(true); }}
              onToggle={(enabled) => toggle.mutate({ id: r.id, enabled })}
              onDelete={() =>
                setConfirm({
                  title: "Delete rule?",
                  message: `Delete "${r.name}"? Events of this type will stop being recognised by this webhook.`,
                  confirmLabel: "Delete",
                  onConfirm: () => { remove.mutate(r.id); setConfirm(null); },
                })
              }
            />
          ))}
        </ul>
      )}

      {formOpen && (
        <RuleFormModal
          webhookId={webhookId}
          rule={editing}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onSaved={() => { setFormOpen(false); setEditing(null); invalidate(); }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

function RuleRow({ rule, onEdit, onToggle, onDelete }) {
  const condCount = (rule.match_conditions || []).length;
  const summary = summarizeConditions(rule.match_conditions);
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 hover:bg-hover">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{rule.name}</span>
          <Badge color={rule.enabled ? "green" : "neutral"}>{rule.enabled ? "enabled" : "disabled"}</Badge>
          <span className="text-[10px] rounded-full bg-hover text-muted border border-card-border px-1.5 py-0.5 font-mono">
            p{rule.priority}
          </span>
          {rule.event_type && (
            <span className="text-[11px] font-mono text-blue-500 truncate">→ {rule.event_type}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
          <span className="font-mono truncate" title={summary.full}>{summary.short}</span>
          <span className="shrink-0">· {condCount} condition{condCount === 1 ? "" : "s"}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onToggle(!rule.enabled)}
        title={rule.enabled ? "Disable" : "Enable"}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground shrink-0"
      >
        <Icon icon={rule.enabled ? "heroicons-outline:pause" : "heroicons-outline:play"} className="text-sm" />
      </button>
      <button
        type="button"
        onClick={onEdit}
        title="Edit"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground shrink-0"
      >
        <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="Delete"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500 shrink-0"
      >
        <Icon icon="heroicons-outline:trash" className="text-sm" />
      </button>
    </li>
  );
}

// One-line condition summary for the list (ported from v2).
function summarizeConditions(conds) {
  if (!conds || conds.length === 0) {
    return { short: "(matches anything)", full: "no conditions" };
  }
  const first = conds[0];
  const rest = conds.length - 1;
  const opLabel =
    first.op === "exists" ? "exists"
    : first.op === "not_exists" ? "missing"
    : first.op === "equals" ? `= ${JSON.stringify(first.value)}`
    : first.op === "not_equals" ? `≠ ${JSON.stringify(first.value)}`
    : first.op === "contains" ? `contains ${JSON.stringify(first.value)}`
    : first.op;
  const short = `${first.path} ${opLabel}${rest > 0 ? ` (+${rest} more)` : ""}`;
  const full = conds
    .map((c) => `${c.path} ${c.op}${c.value !== undefined && c.value !== null ? " " + JSON.stringify(c.value) : ""}`)
    .join(" AND ");
  return { short, full };
}
