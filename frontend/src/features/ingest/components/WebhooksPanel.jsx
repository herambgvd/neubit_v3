"use client";

// Webhook list within a category — create/edit (inline <WebhookForm>), row actions
// (detail modal, edit, delete) and the read-only receiver URL + copy.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { AUTH_PILL, authLabel } from "../constants";
import { receiverUrl, copyToClipboard } from "../lib/receiverUrl";
import WebhookForm from "./WebhookForm";
import WebhookDetailModal from "./WebhookDetailModal";

// An auth type that needs a secret but has none configured means the receiver
// rejects every delivery — v2 flagged this on the row, so surface it here too.
function AuthBadge({ webhook }) {
  const missingSecret = webhook.auth_type !== "none" && !webhook.has_secret;
  return (
    <span
      title={missingSecret ? "Missing secret — edit to fix" : undefined}
      className={`inline-flex items-center gap-1 text-[10px] rounded-full border px-1.5 py-0.5 font-medium ${
        missingSecret
          ? "bg-red-500/10 text-red-500 border-red-500/20"
          : AUTH_PILL[webhook.auth_type] || AUTH_PILL.none
      }`}
    >
      <Icon
        icon={webhook.auth_type === "none" ? "heroicons-mini:lock-open" : "heroicons-mini:lock-closed"}
        className="text-[11px]"
      />
      {authLabel(webhook.auth_type)}
      {missingSecret && " — no secret"}
    </span>
  );
}

export default function WebhooksPanel({ category, catId, canManage }) {
  const qc = useQueryClient();
  const key = ["ingest-webhooks", catId];
  const hooksQ = useQuery({
    queryKey: key,
    queryFn: () => ingestApi.webhooks.list({ category_id: catId, limit: 100 }),
  });
  const hooks = asItems(hooksQ.data);

  const hookId = (h) => h.id ?? h.webhook_id;

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null); // webhook whose receiver URL is shown
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => ingestApi.webhooks.remove(id),
    onSuccess: () => {
      toast.success("Webhook removed");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Webhooks</h3>
          <p className="text-xs text-muted">
            {hooks.length} webhook(s) in <span className="font-medium">{category.name}</span>.
          </p>
        </div>
        {canManage && !creating && !editing && (
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setCreating(true)} className="!px-3 !py-1.5 text-xs">
            Add webhook
          </Button>
        )}
      </div>

      {(creating || editing) && (
        <WebhookForm
          categoryId={catId}
          webhook={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: key });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {!creating && !editing &&
        (hooksQ.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="!h-4 !w-4" /> Loading webhooks…
          </div>
        ) : hooks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-6 py-10 text-center text-sm text-muted">
            {canManage ? (
              <>
                No webhooks yet. Click <b>Add webhook</b> to create one.
              </>
            ) : (
              "No webhooks in this category yet."
            )}
          </div>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border bg-card">
            {hooks.map((h) => (
              <li key={hookId(h)} className="px-4 py-3 hover:bg-hover">
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0 border border-card-border">
                    <Icon icon="heroicons-outline:bolt" className="text-base" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{h.name}</span>
                      <AuthBadge webhook={h} />
                      <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${h.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"}`}>
                        {h.is_active !== false ? "Active" : "Inactive"}
                      </span>
                    </div>
                    {h.description && (
                      <p className="mt-0.5 text-[11px] text-muted line-clamp-1">{h.description}</p>
                    )}
                    {h.slug && (
                      <div className="mt-1 flex items-center gap-2">
                        <code className="text-[11px] font-mono text-muted truncate max-w-full">{receiverUrl(h.slug, h.ingest_url)}</code>
                        <button
                          onClick={() => copyToClipboard(receiverUrl(h.slug, h.ingest_url))}
                          title="Copy receiver URL"
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground shrink-0"
                        >
                          <Icon icon="heroicons-outline:clipboard-document" className="text-sm" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setDetail(h)} title="Details" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-blue-500">
                      <Icon icon="heroicons-outline:eye" className="text-sm" />
                    </button>
                    {canManage && (
                      <>
                        <button onClick={() => setEditing(h)} title="Edit" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                          <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                        </button>
                        <button
                          onClick={() =>
                            setConfirm({
                              title: "Delete webhook?",
                              message: `Delete webhook "${h.name}"? Its event rules and the receiver URL go with it.`,
                              confirmLabel: "Delete",
                              danger: true,
                              onConfirm: () => {
                                remove.mutate(hookId(h));
                                setConfirm(null);
                              },
                            })
                          }
                          title="Delete"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                        >
                          <Icon icon="heroicons-outline:trash" className="text-sm" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {detail && (
        <WebhookDetailModal
          webhook={detail}
          canManage={canManage}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setDetail(null);
            setEditing(detail);
          }}
          onChanged={() => qc.invalidateQueries({ queryKey: key })}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
