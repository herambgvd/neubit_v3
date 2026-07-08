"use client";

// Unified incident action bar — one cohesive row of controls that replaces the
// scattered ManagePanel buttons: the legal status actions for the current status
// (Activate / Pause / Resume / Resolve / Cancel), Escalate, Assign, and Export
// PDF. Presentational: the parent owns the mutations + the reason/assign modals
// and passes handlers + pending flags. Only legal actions are offered (the
// backend enforces the machine; we don't render illegal ones).
import { useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "../../api";

// status → status actions offered from it. `reason:true` routes through the
// reason modal; `outcome` (when set) is passed to setStatus as the outcome.
export const STATUS_ACTIONS = {
  pending: [{ status: "active", label: "Activate", icon: "heroicons-outline:play", variant: "primary" }],
  active: [
    { status: "paused", label: "Pause", icon: "heroicons-outline:pause", variant: "secondary" },
    { status: "resolved", label: "Resolve", icon: "heroicons-outline:check-circle", variant: "success", reason: true },
    { status: "cancelled", label: "Cancel", icon: "heroicons-outline:x-circle", variant: "danger", reason: true },
  ],
  paused: [
    { status: "active", label: "Resume", icon: "heroicons-outline:play", variant: "primary" },
    { status: "resolved", label: "Resolve", icon: "heroicons-outline:check-circle", variant: "success", reason: true },
    { status: "cancelled", label: "Cancel", icon: "heroicons-outline:x-circle", variant: "danger", reason: true },
  ],
};

const TERMINAL = new Set(["resolved", "completed", "cancelled"]);

export default function IncidentActionBar({
  instance,
  actionPending,
  onStatusAction,
  onEscalate,
  onAssign,
}) {
  const inst = instance;
  const id = inst.instance_id || inst.id;
  const status = inst.status;
  const terminal = TERMINAL.has(status);
  const statusActions = STATUS_ACTIONS[status] || [];
  const assigned = inst.assigned_to ?? inst.assignee_id ?? inst.assignment?.assigned_to;

  const [pdfLoading, setPdfLoading] = useState(false);

  async function exportPdf() {
    setPdfLoading(true);
    try {
      const blob = await wfApi.instances.pdfBlob(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `incident-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e) || "PDF export failed");
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-card-border bg-card px-4 py-3">
      {/* Status lifecycle actions */}
      {statusActions.map((a) => (
        <Button
          key={a.status}
          variant={a.variant}
          icon={a.icon}
          onClick={() => onStatusAction(a)}
          disabled={actionPending}
          className="!px-3 !py-1.5 text-xs"
        >
          {a.label}
        </Button>
      ))}

      {statusActions.length > 0 && <span className="mx-1 h-5 w-px bg-card-border" />}

      <Button
        variant="secondary"
        icon="heroicons-outline:arrow-trending-up"
        onClick={onEscalate}
        disabled={actionPending || terminal}
        className="!px-3 !py-1.5 text-xs"
      >
        Escalate
      </Button>

      <Button
        variant="secondary"
        icon="heroicons-outline:user-plus"
        onClick={onAssign}
        disabled={actionPending}
        className="!px-3 !py-1.5 text-xs"
      >
        {assigned ? "Reassign" : "Assign"}
      </Button>

      <Button
        variant="secondary"
        onClick={exportPdf}
        disabled={pdfLoading}
        className="!px-3 !py-1.5 text-xs ml-auto"
      >
        {pdfLoading ? (
          <Spinner className="!h-3.5 !w-3.5" />
        ) : (
          <Icon icon="heroicons-outline:arrow-down-tray" className="text-base" />
        )}
        Export PDF
      </Button>
    </div>
  );
}
