"use client";

// Tabbed webhook detail modal — Overview (+ receiver URL / copy / rotate-secret),
// Test (dry-run) and Recent events. Custom modal shell (tabbed + scroll body +
// sticky footer) with the shared <TabBar> for the tabs.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { InfoCell } from "@/components/console";
import { Button, ConfirmDialog, Overlay } from "@/components/ui/kit";
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

export default function WebhookDetailModal({ webhook, onClose, onChanged }: any) {
  const [tab, setTab] = useState("overview");
  const [token, setToken] = useState(webhook.token); // updates live after a rotate
  const [confirm, setConfirm] = useState<any>(null);
  const hookId = webhook.id ?? webhook.webhook_id;

  const rotate = useMutation<any>({
    mutationFn: () => ingestApi.webhooks.rotateSecret(hookId),
    onSuccess: (res) => {
      toast.success("Receiver token rotated");
      if (res?.token) setToken(res.token);
      onChanged?.();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const url = receiverUrl(token);

  return (
    <Overlay onClose={onClose}>
      {/* A FIXED height, not max-h: this is a four-tab inspector and Rules / Test /
          Recent events each carry far more than the Overview. With max-h the dialog
          resized on every tab switch (and cramped the tabs that actually need room);
          h-[min(…)] keeps the frame still and gives each tab the same tall body. */}
      <div className="relative flex h-[min(86vh,820px)] w-full max-w-4xl flex-col rounded-xl border border-nb-line bg-[rgba(8,15,34,.93)] shadow-2xl backdrop-blur-md animate-modal-in">
        <div className="flex shrink-0 items-center justify-between border-b border-nb-line px-5 py-4">
          <h3 className="text-base font-semibold text-nb-ink">{webhook.name}</h3>
          <button onClick={onClose} className="text-nb-muted transition hover:text-nb-ink">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>

        {/* px-1 + the tab's own px-4 = 20px, so the first tab's label sits on the same
            left edge as the body's px-5 content. */}
        <TabBar tabs={DETAIL_TABS} active={tab} onChange={setTab} className="px-1 shrink-0" />

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === "overview" && (
            <div className="space-y-4">
              <div>
                <FieldLabel>Public receiver URL</FieldLabel>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-lg border border-nb-line bg-nb-field px-3 py-2 font-mono text-xs text-nb-blueb">{url}</code>
                  <Button variant="secondary" icon="heroicons-outline:clipboard-document" onClick={() => copyToClipboard(url)}>
                    Copy
                  </Button>
                  <Button
                    variant="warn"
                    icon="heroicons-outline:arrow-path"
                    disabled={rotate.isPending}
                    onClick={() => setConfirm({
                      title: "Rotate receiver token?",
                      message: "The current URL will stop working immediately. Any integrations must be updated to the new URL.",
                      confirmLabel: "Rotate",
                      onConfirm: () => { rotate.mutate(); setConfirm(null); },
                    })}
                  >
                    Rotate
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-nb-faint">Point your external system at this URL to POST events.</p>
              </div>

              {/* Read-only facts use the shared InfoCell, like every other detail pane. */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <InfoCell label="Auth type" value={authLabel(webhook.auth_type)} />
                <InfoCell label="Request method" value={(webhook.request_method || "post").toUpperCase()} />
                <InfoCell label="Status" value={webhook.is_active !== false ? "Active" : "Inactive"} />
              </div>

              <JsonBlock label="Transform (field map)" value={webhook.transform} empty="No field map — the raw payload is stored as-is." />
              <JsonBlock label="Schema (JSON)" value={webhook.payload_schema} empty="No schema — incoming payloads are not validated." />
            </div>
          )}

          {tab === "rules" && <RulesPanel webhookId={hookId} />}
          {tab === "test" && <WebhookTestPanel hookId={hookId} />}
          {tab === "events" && <WebhookEventsPanel hookId={hookId} />}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-nb-line px-5 py-4">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={rotate.isPending} />
    </Overlay>
  );
}

// A pretty-printed JSON value, or an explanatory empty state. The overview used to
// render a bare "—" inside a full-height code box, which read as a broken field
// rather than "nothing configured".
function JsonBlock({ label, value, empty }: any) {
  const has = value && Object.keys(value).length > 0;
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {has ? (
        <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-nb-line bg-nb-field px-3 py-2 font-mono text-xs text-nb-soft">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <p className="mt-1 rounded-lg border border-dashed border-nb-line px-3 py-2 text-xs text-nb-faint">{empty}</p>
      )}
    </div>
  );
}
