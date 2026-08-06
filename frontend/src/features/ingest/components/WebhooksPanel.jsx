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

export default function WebhooksPanel({ category, catId }) {
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
    <div className="space-y-4 px-5 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Webhooks</h3>
          <p className="mt-0.5 text-[11.5px] text-nb-faint">
            {hooks.length} webhook{hooks.length === 1 ? "" : "s"} in{" "}
            <span className="font-medium text-nb-soft">{category.name}</span>.
          </p>
        </div>
        {!creating && !editing && (
          <Button variant="action" icon="heroicons-outline:plus" onClick={() => setCreating(true)} className="!px-3 !py-1.5 text-xs">
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
          <div className="flex items-center gap-2 text-sm text-nb-soft">
            <Spinner className="!h-4 !w-4" /> Loading webhooks…
          </div>
        ) : hooks.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-nb-line px-6 py-10 text-center text-[12.5px] text-nb-faint">
            No webhooks yet. Click <b className="text-nb-blueb">Add webhook</b> to create one.
          </div>
        ) : (
          <div className="space-y-2">
            {hooks.map((h) => (
              <div key={hookId(h)} className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3.5 py-3 transition hover:border-[rgba(150,180,245,.42)]">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] text-nb-blueb">
                    <Icon icon="heroicons-outline:bolt" className="text-base" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-nb-ink">{h.name}</span>
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${AUTH_PILL[h.auth_type] || AUTH_PILL.none}`}>
                        {authLabel(h.auth_type)}
                      </span>
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${h.is_active !== false ? "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good" : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint"}`}>
                        {h.is_active !== false ? "Active" : "Inactive"}
                      </span>
                    </div>
                    {h.token && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <code className="max-w-full truncate font-mono text-[11px] text-nb-faint">{receiverUrl(h.token)}</code>
                        <button
                          onClick={() => copyToClipboard(receiverUrl(h.token))}
                          title="Copy receiver URL"
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-nb-faint transition hover:bg-white/5 hover:text-nb-blueb"
                        >
                          <Icon icon="heroicons-outline:clipboard-document" className="text-sm" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => setDetail(h)} title="Details" className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-nb-faint transition hover:bg-white/5 hover:text-nb-blueb">
                      <Icon icon="heroicons-outline:eye" className="text-sm" />
                    </button>
                    <button onClick={() => setEditing(h)} title="Edit" className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-nb-faint transition hover:bg-white/5 hover:text-nb-ink">
                      <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                    </button>
                    <button
                      onClick={() =>
                        setConfirm({
                          title: "Delete webhook?",
                          message: `Delete webhook "${h.name}"?`,
                          confirmLabel: "Delete",
                          onConfirm: () => {
                            remove.mutate(hookId(h));
                            setConfirm(null);
                          },
                        })
                      }
                      title="Delete"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-nb-crit transition hover:bg-[rgba(248,113,113,.12)]"
                    >
                      <Icon icon="heroicons-outline:trash" className="text-sm" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}

      {detail && (
        <WebhookDetailModal
          webhook={detail}
          onClose={() => setDetail(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: key })}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
