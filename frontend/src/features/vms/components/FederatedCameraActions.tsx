"use client";

// FederatedCameraActions — the operate-THROUGH-node control bar for a recorder-
// owned (federated) camera. A federated camera is NODE-AUTHORITATIVE: the VMS
// never mutates it directly, it PROXIES each operational action to the owning
// recorder (same seam as PTZ + snapshot). This bar exposes four such actions —
// manual recording, reboot, evidence hold and clip export — each rendered ONLY
// when the operator holds the matching permission (hidden, not disabled), and
// each toasts the node's result.
//
// Perm gates use the app's real permission strings (auth `can()`):
//   • recording start/stop  → vms.recording.control
//   • reboot                → vms.config.manage  (the device-reboot perm)
//   • evidence hold         → vms.recording.control  (evidence writes, as elsewhere)
//   • clip export           → vms.playback.view  (the export/investigation surface)
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal, ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { vms } from "../api";

// Small pill-button matching the header's Snapshot control exactly.
const BTN =
  "inline-flex items-center gap-1 rounded-md border border-nb-line bg-nb-surface px-2 py-1 text-[11px] font-medium text-nb-soft transition hover:border-nb-blueb hover:text-nb-ink disabled:opacity-50";

// datetime-local <-> ISO helpers (same convention as EvidenceLockModal).
function toLocalInput(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

const READY = new Set<any>(["ready", "done", "complete", "completed", "succeeded"]);
const FAILED = new Set<any>(["failed", "error"]);

export default function FederatedCameraActions({ camera }: any) {
  const { can } = useAuth();
  const node = camera.node_id;
  const cam = camera.real_id;

  const canRecord = can("vms.recording.control");
  const canReboot = can("vms.config.manage");
  const canHold = can("vms.recording.control");
  const canExport = can("vms.playback.view");

  const [recBusy, setRecBusy] = useState<any>(null); // "start" | "stop" | null
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false); // quick "last 15 min"
  const [holdOpen, setHoldOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Nothing to render if the operator holds none of the four perms.
  if (!canRecord && !canReboot && !canHold && !canExport) return null;

  const record = async (mode) => {
    setRecBusy(mode);
    try {
      if (mode === "start") await vms.federation.actions.recordStart(node, cam);
      else await vms.federation.actions.recordStop(node, cam);
      toast.success(mode === "start" ? "Recording started" : "Recording stopped");
    } catch (e) {
      toast.error(apiError(e, "Recording control failed"));
    } finally {
      setRecBusy(null);
    }
  };

  const reboot = async () => {
    setRebooting(true);
    try {
      await vms.federation.actions.reboot(node, cam);
      toast.success("Reboot sent");
      setConfirmReboot(false);
    } catch (e) {
      toast.error(apiError(e, "Reboot failed"));
    } finally {
      setRebooting(false);
    }
  };

  const quickHold = async () => {
    setHoldBusy(true);
    const to = new Date();
    const from = new Date(to.getTime() - 15 * 60 * 1000);
    try {
      await vms.federation.actions.holdCreate(
        node,
        cam,
        from.toISOString(),
        to.toISOString(),
        "operator hold",
      );
      toast.success("Evidence hold placed — last 15 min protected");
    } catch (e) {
      toast.error(apiError(e, "Could not place evidence hold"));
    } finally {
      setHoldBusy(false);
    }
  };

  return (
    <>
      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
        <span className="mr-0.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-faint">
          <Icon icon="heroicons-outline:bolt" className="text-[11px]" />
          Actions
        </span>

        {canRecord && (
          <span className="inline-flex overflow-hidden rounded-md border border-nb-line">
            <button
              type="button"
              onClick={() => record("start")}
              disabled={recBusy != null}
              title="Start recording on the recorder"
              className="inline-flex items-center gap-1 bg-nb-surface px-2 py-1 text-[11px] font-medium text-nb-soft transition hover:bg-nb-crit/10 hover:text-nb-crit disabled:opacity-50"
            >
              {recBusy === "start" ? (
                <Icon icon="heroicons-outline:arrow-path" className="animate-spin text-xs text-nb-crit" />
              ) : (
                <span className="inline-block h-2 w-2 rounded-full bg-nb-crit" />
              )}
              Rec
            </button>
            <button
              type="button"
              onClick={() => record("stop")}
              disabled={recBusy != null}
              title="Stop recording on the recorder"
              className="inline-flex items-center gap-1 border-l border-nb-line bg-nb-surface px-2 py-1 text-[11px] font-medium text-nb-soft transition hover:border-nb-blueb hover:text-nb-ink disabled:opacity-50"
            >
              <Icon
                icon={recBusy === "stop" ? "heroicons-outline:arrow-path" : "heroicons-mini:stop"}
                className={`text-xs ${recBusy === "stop" ? "animate-spin" : ""}`}
              />
              Stop
            </button>
          </span>
        )}

        {canReboot && (
          <button
            type="button"
            onClick={() => setConfirmReboot(true)}
            title="Reboot the camera through its recorder"
            className={BTN}
          >
            <Icon icon="heroicons-outline:arrow-path" className="text-xs" />
            Reboot
          </button>
        )}

        {canHold && (
          <span className="inline-flex overflow-hidden rounded-md border border-nb-line">
            <button
              type="button"
              onClick={quickHold}
              disabled={holdBusy}
              title="Retention-lock the last 15 minutes of footage"
              className="inline-flex items-center gap-1 bg-nb-surface px-2 py-1 text-[11px] font-medium text-nb-soft transition hover:border-nb-blueb hover:text-nb-ink disabled:opacity-50"
            >
              <Icon
                icon={holdBusy ? "heroicons-outline:arrow-path" : "heroicons-outline:lock-closed"}
                className={`text-xs ${holdBusy ? "animate-spin" : ""}`}
              />
              Hold 15 min
            </button>
            <button
              type="button"
              onClick={() => setHoldOpen(true)}
              title="Lock a custom range as evidence"
              className="inline-flex items-center border-l border-nb-line bg-nb-surface px-1.5 py-1 text-[11px] font-medium text-nb-soft transition hover:border-nb-blueb hover:text-nb-ink"
            >
              <Icon icon="heroicons-outline:ellipsis-horizontal" className="text-xs" />
            </button>
          </span>
        )}

        {canExport && (
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            title="Export a clip through the recorder"
            className={BTN}
          >
            <Icon icon="heroicons-outline:scissors" className="text-xs" />
            Export clip
          </button>
        )}
      </div>

      <ConfirmDialog
        state={
          confirmReboot
            ? {
                title: "Reboot camera?",
                message:
                  "The recorder will reboot this camera. It will drop offline for a minute or so while it restarts.",
                confirmLabel: "Reboot",
                icon: "heroicons-outline:arrow-path",
                onConfirm: reboot,
              }
            : null
        }
        onClose={() => (rebooting ? null : setConfirmReboot(false))}
        pending={rebooting}
      />

      {holdOpen && (
        <FedHoldModal camera={camera} onClose={() => setHoldOpen(false)} />
      )}
      {exportOpen && (
        <FedExportModal camera={camera} onClose={() => setExportOpen(false)} />
      )}
    </>
  );
}

// ── Evidence hold — custom range ──────────────────────────────────────────────
// Retention-lock an arbitrary [from,to] window on the owning recorder.
function FedHoldModal({ camera, onClose }: any) {
  const node = camera.node_id;
  const cam = camera.real_id;
  const now = new Date();
  const [from, setFrom] = useState(toLocalInput(new Date(now.getTime() - 15 * 60 * 1000)));
  const [to, setTo] = useState(toLocalInput(now));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const fromIso = fromLocalInput(from);
  const toIso = fromLocalInput(to);
  const rangeValid = fromIso && toIso && new Date(toIso) > new Date(fromIso);

  const save = async () => {
    if (!rangeValid) return;
    setSaving(true);
    try {
      await vms.federation.actions.holdCreate(
        node,
        cam,
        fromIso,
        toIso,
        reason.trim() || "operator hold",
      );
      toast.success("Evidence hold placed — this range is protected from deletion");
      onClose?.();
    } catch (e) {
      toast.error(apiError(e, "Could not place evidence hold"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Evidence hold"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="heroicons-outline:lock-closed"
            disabled={!rangeValid || saving}
            onClick={save}
          >
            {saving ? "Placing…" : "Place hold"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-nb-warn/30 bg-nb-warn/10 px-3 py-2 text-xs text-nb-warn">
          Footage overlapping this range is retention-locked on{" "}
          <span className="font-medium">{camera.node_name || "the recorder"}</span> until the hold is
          released.
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-nb-faint">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 w-full rounded-lg border border-nb-line bg-transparent px-3 text-sm text-nb-ink outline-hidden focus:border-nb-blueb"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-nb-faint">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 w-full rounded-lg border border-nb-line bg-transparent px-3 text-sm text-nb-ink outline-hidden focus:border-nb-blueb"
            />
          </label>
        </div>
        {!rangeValid && <p className="text-xs text-nb-warn">Pick a valid range (To must be after From).</p>}
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-nb-faint">Reason</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="operator hold"
            maxLength={2000}
            className="h-9 w-full rounded-lg border border-nb-line bg-transparent px-3 text-sm text-nb-ink outline-hidden focus:border-nb-blueb"
          />
        </label>
      </div>
    </Modal>
  );
}

// ── Clip export — job through the node ────────────────────────────────────────
// POST createExport → poll getExport until ready/failed → Download (authed blob).
// Polling lives inside this modal so it stops the moment the modal unmounts.
function FedExportModal({ camera, onClose }: any) {
  const node = camera.node_id;
  const cam = camera.real_id;
  const now = new Date();
  const [from, setFrom] = useState(toLocalInput(new Date(now.getTime() - 5 * 60 * 1000)));
  const [to, setTo] = useState(toLocalInput(now));
  const [job, setJob] = useState<any>(null); // { id, status }
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef<any>(null);

  const fromIso = fromLocalInput(from);
  const toIso = fromLocalInput(to);
  const rangeValid = fromIso && toIso && new Date(toIso) > new Date(fromIso);
  const status = job?.status;
  const ready = status && READY.has(String(status).toLowerCase());
  const failed = status && FAILED.has(String(status).toLowerCase());

  // Poll while the job is in flight; cancel on unmount / terminal state.
  useEffect(() => {
    if (!job?.id || ready || failed) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await vms.federation.actions.getExport(node, job.id);
        if (cancelled) return;
        setJob(next);
        const s = String(next?.status || "").toLowerCase();
        if (!READY.has(s) && !FAILED.has(s)) pollRef.current = setTimeout(tick, 2000);
      } catch {
        if (!cancelled) pollRef.current = setTimeout(tick, 2000);
      }
    };
    pollRef.current = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [job?.id, ready, failed, node]);

  const start = async () => {
    if (!rangeValid) return;
    setSubmitting(true);
    try {
      const res = await vms.federation.actions.createExport(node, cam, fromIso, toIso);
      setJob({ id: res.id, status: res.status || "queued" });
    } catch (e) {
      toast.error(apiError(e, "Could not start the export"));
    } finally {
      setSubmitting(false);
    }
  };

  const download = async () => {
    if (!job?.id) return;
    setDownloading(true);
    try {
      const blob = await vms.federation.actions.downloadExportBlob(node, job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${camera.name || cam}-${job.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "Download failed"));
    } finally {
      setDownloading(false);
    }
  };

  const pending = !!job && !ready && !failed;

  return (
    <Modal
      open
      onClose={onClose}
      title="Export clip"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {ready ? (
            <Button
              variant="success"
              icon="heroicons-outline:arrow-down-tray"
              disabled={downloading}
              onClick={download}
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="heroicons-outline:scissors"
              disabled={!rangeValid || submitting || pending}
              onClick={start}
            >
              {submitting ? "Starting…" : pending ? "Exporting…" : "Export"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[rgba(96,165,250,.3)] bg-[rgba(96,165,250,.08)] px-3 py-2 text-xs text-nb-blueb">
          The clip is cut on{" "}
          <span className="font-medium">{camera.node_name || "the recorder"}</span> and streamed back
          through it — nothing leaves the node until you download.
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-nb-faint">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={pending || ready}
              className="h-9 w-full rounded-lg border border-nb-line bg-transparent px-3 text-sm text-nb-ink outline-hidden focus:border-nb-blueb disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-nb-faint">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={pending || ready}
              className="h-9 w-full rounded-lg border border-nb-line bg-transparent px-3 text-sm text-nb-ink outline-hidden focus:border-nb-blueb disabled:opacity-50"
            />
          </label>
        </div>
        {!rangeValid && !job && (
          <p className="text-xs text-nb-warn">Pick a valid range (To must be after From).</p>
        )}
        {job && (
          <div className="flex items-center gap-2 rounded-lg border border-nb-line bg-nb-surface px-3 py-2 text-xs">
            <Icon
              icon={
                failed
                  ? "heroicons-outline:exclamation-triangle"
                  : ready
                    ? "heroicons-outline:check-circle"
                    : "heroicons-outline:arrow-path"
              }
              className={`text-sm ${failed ? "text-nb-crit" : ready ? "text-nb-teal" : "animate-spin text-nb-blueb"}`}
            />
            <span className={failed ? "text-nb-crit" : "text-nb-soft"}>
              {failed
                ? "Export failed on the recorder."
                : ready
                  ? "Clip ready — download it below."
                  : `Working on the recorder… (${status || "queued"})`}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
