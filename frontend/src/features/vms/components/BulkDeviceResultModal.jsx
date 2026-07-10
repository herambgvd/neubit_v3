"use client";

// Per-camera results summary for a bulk G7 device op (reboot | ntp | password).
// The bulk endpoint returns { action, total, succeeded, items:[{ camera_id,
// camera_name, ok, supported, detail }] } — we render a headline (N/total
// succeeded) then the full per-camera list, flagging unsupported vs failed.
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";

const ACTION_LABEL = { reboot: "Reboot", ntp: "Set NTP", password: "Change password" };

function statusFor(item) {
  if (item.ok) return { icon: "heroicons:check-circle", tone: "text-emerald-500", label: "Applied" };
  if (item.supported === false)
    return { icon: "heroicons:no-symbol", tone: "text-muted", label: "Not supported" };
  return { icon: "heroicons:x-circle", tone: "text-red-500", label: "Failed" };
}

export default function BulkDeviceResultModal({ result, onClose }) {
  if (!result) return null;
  const items = result.items || [];
  const total = result.total ?? items.length;
  const succeeded = result.succeeded ?? items.filter((i) => i.ok).length;
  const failures = items.filter((i) => !i.ok);

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`${ACTION_LABEL[result.action] || result.action} — results`}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3 rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-lg ${
              succeeded === total ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"
            }`}
          >
            <Icon icon="heroicons:server-stack" className="text-base" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {succeeded} of {total} succeeded
            </p>
            {failures.length > 0 && (
              <p className="text-[11px] text-muted">{failures.length} camera(s) reported an issue — see below.</p>
            )}
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-card-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-hover/40 text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Camera</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const s = statusFor(it);
                return (
                  <tr key={it.camera_id} className="border-b border-card-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{it.camera_name || it.camera_id}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-xs ${s.tone}`}>
                        <Icon icon={s.icon} className="text-sm" /> {s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{it.detail || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
