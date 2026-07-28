"use client";

// Tabbed webhook detail modal — Overview (+ receiver URL / copy / rotate-secret),
// Test (dry-run) and Recent events. Custom modal shell (tabbed + scroll body +
// sticky footer) with the shared <TabBar> for the tabs.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog } from "@/components/ui/kit";
import { TabBar, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { authLabel } from "../constants";
import { receiverUrl, copyToClipboard } from "../lib/receiverUrl";
import WebhookTestPanel from "./WebhookTestPanel";
import WebhookEventsPanel from "./WebhookEventsPanel";
import RulesPanel from "./RulesPanel";

const DETAIL_TABS = [
  { key: "overview", label: "Overview", icon: "heroicons-outline:information-circle" },
  { key: "rules", label: "Rules", icon: "heroicons-outline:funnel" },
  { key: "test", label: "Test", icon: "heroicons-outline:beaker" },
  { key: "events", label: "Recent events", icon: "heroicons-outline:queue-list" },
];

export default function WebhookDetailModal({ webhook, onClose, onChanged }) {
  const [tab, setTab] = useState("overview");
  const [token, setToken] = useState(webhook.token); // updates live after a rotate
  const [confirm, setConfirm] = useState(null);
  const hookId = webhook.id ?? webhook.webhook_id;

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rotate = useMutation({
    mutationFn: () => ingestApi.webhooks.rotateSecret(hookId, false),
    onSuccess: (res) => {
      toast.success("Receiver token rotated");
      if (res?.token) setToken(res.token);
      onChanged?.();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const url = receiverUrl(token);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-nb-line bg-[rgba(8,15,34,.93)] shadow-2xl backdrop-blur-md animate-modal-in">
        <div className="flex shrink-0 items-center justify-between border-b border-nb-line px-5 py-4">
          <h3 className="text-base font-semibold text-nb-ink">{webhook.name}</h3>
          <button onClick={onClose} className="text-nb-muted transition hover:text-nb-ink">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>

        <TabBar tabs={DETAIL_TABS} active={tab} onChange={setTab} className="px-3 shrink-0" />

        <div className="px-6 py-5 overflow-y-auto">
          {tab === "overview" && (
            <div className="space-y-5">
              <div>
                <FieldLabel>Public receiver URL</FieldLabel>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 break-all rounded-[8px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-2 font-mono text-xs text-nb-blueb">{url}</code>
                  <button onClick={() => copyToClipboard(url)} className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-nb-line px-2.5 py-2 text-xs text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb">
                    <Icon icon="heroicons-outline:clipboard-document" className="text-sm" /> Copy
                  </button>
                  <button
                    onClick={() => setConfirm({
                      title: "Rotate receiver token?",
                      message: "The current URL will stop working immediately. Any integrations must be updated to the new URL.",
                      confirmLabel: "Rotate",
                      onConfirm: () => { rotate.mutate(); setConfirm(null); },
                    })}
                    disabled={rotate.isPending}
                    className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.1)] px-2.5 py-2 text-xs text-nb-warn transition hover:bg-[rgba(251,191,36,.18)] disabled:opacity-50"
                  >
                    <Icon icon="heroicons-outline:arrow-path" className="text-sm" /> Rotate
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-nb-faint">Point your external system at this URL to POST events.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><FieldLabel>Auth type</FieldLabel><p className="mt-1 text-sm text-nb-soft">{authLabel(webhook.auth_type)}</p></div>
                <div><FieldLabel>Status</FieldLabel><p className="mt-1 text-sm text-nb-soft">{webhook.is_active !== false ? "Active" : "Inactive"}</p></div>
              </div>
              <div>
                <FieldLabel>Transform (field map)</FieldLabel>
                <pre className="mt-1 whitespace-pre-wrap break-all rounded-[8px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-2 font-mono text-xs text-nb-soft">
                  {webhook.transform && Object.keys(webhook.transform).length ? JSON.stringify(webhook.transform, null, 2) : "—"}
                </pre>
              </div>
              <div>
                <FieldLabel>Schema (JSON)</FieldLabel>
                <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-2 font-mono text-xs text-nb-soft">
                  {webhook.payload_schema && Object.keys(webhook.payload_schema).length ? JSON.stringify(webhook.payload_schema, null, 2) : "—"}
                </pre>
              </div>
            </div>
          )}

          {tab === "rules" && <RulesPanel webhookId={hookId} />}
          {tab === "test" && <WebhookTestPanel hookId={hookId} />}
          {tab === "events" && <WebhookEventsPanel hookId={hookId} />}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-nb-line px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={rotate.isPending} />
    </div>
  );
}
