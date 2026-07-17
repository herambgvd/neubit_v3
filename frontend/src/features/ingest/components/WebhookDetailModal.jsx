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
  { key: "rules", label: "Event types", icon: "heroicons-outline:funnel" },
  { key: "overview", label: "Overview", icon: "heroicons-outline:information-circle" },
  { key: "test", label: "Test", icon: "heroicons-outline:beaker" },
  { key: "events", label: "API hits", icon: "heroicons-outline:queue-list" },
];

function Row({ label, children }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1 text-sm text-foreground">{children}</p>
    </div>
  );
}

export default function WebhookDetailModal({ webhook, canManage, onClose, onEdit, onChanged }) {
  // Rules first: an operator opens a webhook to work on its event types far more
  // often than to re-read its config.
  const [tab, setTab] = useState("rules");
  const [confirm, setConfirm] = useState(null);
  // The freshly minted secret, shown once — the server never returns it again.
  const [newSecret, setNewSecret] = useState(null);
  const hookId = webhook.id ?? webhook.webhook_id;

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rotate = useMutation({
    mutationFn: () => ingestApi.webhooks.rotateSecret(hookId),
    onSuccess: (res) => {
      toast.success("New auth secret generated");
      if (res?.auth_secret) setNewSecret(res.auth_secret);
      onChanged?.();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // The URL never changes here — the slug is fixed at create and rotate only
  // touches the auth secret.
  const url = receiverUrl(webhook.slug, webhook.ingest_url);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      {/* Wide + tall: this modal stands in for what v2 gave a whole page. The
          rule list, the two-column tester and the event-log table all need room
          — at max-w-2xl the tester's columns collapsed and payload JSON wrapped
          to unreadable shreds. */}
      <div className="relative flex max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-card-border bg-card shadow-2xl animate-modal-in">
        <div className="flex items-center justify-between gap-3 border-b border-card-border px-5 py-4 shrink-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">{webhook.name}</h3>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                webhook.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
              }`}
            >
              {webhook.is_active !== false ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canManage && onEdit && (
              <button
                onClick={onEdit}
                className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
              >
                <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
              </button>
            )}
            <button onClick={onClose} className="text-muted transition hover:text-foreground">
              <Icon icon="heroicons-outline:x-mark" className="text-xl" />
            </button>
          </div>
        </div>

        <TabBar tabs={DETAIL_TABS} active={tab} onChange={setTab} className="px-3 shrink-0" />

        <div className="px-6 py-5 overflow-y-auto">
          {tab === "overview" && (
            <div className="space-y-5">
              <div>
                <FieldLabel>Public receiver URL</FieldLabel>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 rounded-lg border border-field bg-hover/40 px-3 py-2 text-xs font-mono text-foreground break-all">{url}</code>
                  <button onClick={() => copyToClipboard(url)} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-2 text-xs text-foreground hover:bg-hover shrink-0">
                    <Icon icon="heroicons-outline:clipboard-document" className="text-sm" /> Copy
                  </button>
                  {canManage && webhook.auth_type !== "none" && (
                    <button
                      onClick={() => setConfirm({
                        title: "Generate a new auth secret?",
                        message:
                          "The current secret stops working immediately — every sender must be updated with the new one. The URL is not affected.",
                        confirmLabel: "Generate",
                        danger: true,
                        onConfirm: () => { rotate.mutate(); setConfirm(null); },
                      })}
                      disabled={rotate.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-500 hover:bg-amber-500/20 shrink-0 disabled:opacity-50"
                    >
                      <Icon icon="heroicons-outline:key" className="text-sm" /> New secret
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted/70">Point your external system at this URL to POST events.</p>
              </div>

              {newSecret && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                  <FieldLabel>New auth secret — copy it now</FieldLabel>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 break-all rounded border border-amber-500/20 bg-card px-2 py-1.5 font-mono text-xs text-foreground">
                      {newSecret}
                    </code>
                    <button
                      onClick={() => copyToClipboard(newSecret)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
                    >
                      <Icon icon="heroicons-outline:clipboard-document" className="text-sm" /> Copy
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-amber-500">
                    This is the only time it is shown — only its hash is stored.
                  </p>
                </div>
              )}
              {webhook.description && (
                <Row label="Description">{webhook.description}</Row>
              )}

              {/* Auth */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Row label="Auth type">
                  <span className="font-mono text-xs">{authLabel(webhook.auth_type)}</span>
                </Row>
                {webhook.auth_username && (
                  <Row label="Username">
                    <span className="font-mono text-xs">{webhook.auth_username}</span>
                  </Row>
                )}
                {webhook.auth_type !== "none" && (
                  <Row label="Secret">
                    {webhook.has_secret ? (
                      <span className="text-emerald-500">configured</span>
                    ) : (
                      <span className="text-red-500">missing — edit to fix</span>
                    )}
                  </Row>
                )}
                <Row label="Method">
                  <span className="font-mono text-xs uppercase">{webhook.request_method || "post"}</span>
                </Row>
              </div>

              {/* Routing */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Row label="Slug">
                  <span className="font-mono text-xs">{webhook.slug}</span>
                </Row>
                <Row label="Default event type">
                  <span className="font-mono text-xs">{webhook.event_type || "ingest.event"}</span>
                </Row>
                <Row label="Status">{webhook.is_active !== false ? "Active" : "Inactive"}</Row>
              </div>

              {/* Device lookup — only when configured (v2 parity). */}
              {webhook.device_lookup_expr && (
                <div>
                  <FieldLabel>Device lookup</FieldLabel>
                  <p className="mt-1 font-mono text-xs text-foreground">{webhook.device_lookup_expr}</p>
                  <p className="mt-1 text-[11px] text-muted/70">
                    Published as <code className="font-mono">device_lookup_value</code>. Resolving it
                    to a device is not wired up yet.
                  </p>
                </div>
              )}

              <div>
                <FieldLabel>Output map (field → JMESPath)</FieldLabel>
                <pre className="mt-1 rounded-lg border border-field bg-hover/40 px-3 py-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all">
                  {webhook.transform && Object.keys(webhook.transform).length ? JSON.stringify(webhook.transform, null, 2) : "—"}
                </pre>
              </div>
              <div>
                <FieldLabel>Accepted payload (JSON Schema)</FieldLabel>
                <pre className="mt-1 rounded-lg border border-field bg-hover/40 px-3 py-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all max-h-52 overflow-auto">
                  {webhook.payload_schema && Object.keys(webhook.payload_schema).length ? JSON.stringify(webhook.payload_schema, null, 2) : "—"}
                </pre>
              </div>
            </div>
          )}

          {tab === "rules" && <RulesPanel webhookId={hookId} canManage={canManage} />}
          {tab === "test" && <WebhookTestPanel webhook={webhook} hookId={hookId} />}
          {tab === "events" && <WebhookEventsPanel hookId={hookId} canManage={canManage} />}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={rotate.isPending} />
    </div>
  );
}
