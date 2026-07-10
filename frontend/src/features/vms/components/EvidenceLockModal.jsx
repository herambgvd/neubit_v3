"use client";

// EvidenceLockModal (G3) — place a legal hold on a camera + time-range.
//
// An active evidence lock protects EVERY recording overlapping [start,end] from
// the retention/tiering worker until it's released. Opened from the Playback
// "Lock as evidence" action (seeded with the loaded window) — gated on
// vms.recording.control (the backend enforces it too).
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export default function EvidenceLockModal({
  open,
  onClose,
  cameraId,
  cameraName,
  seed = null, // { start, end } (ISO) — the window to lock
  onSaved,
}) {
  const [startTs, setStartTs] = useState("");
  const [endTs, setEndTs] = useState("");
  const [reason, setReason] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStartTs(toLocalInput(seed?.start));
    setEndTs(toLocalInput(seed?.end));
    setReason("");
    setCaseRef("");
    setSaving(false);
  }, [open, seed?.start, seed?.end]);

  const startIso = fromLocalInput(startTs);
  const endIso = fromLocalInput(endTs);
  const rangeValid = startIso && endIso && new Date(endIso) > new Date(startIso);

  const save = async () => {
    if (!rangeValid) return;
    setSaving(true);
    try {
      const res = await vms.evidence.create({
        camera_id: cameraId,
        start_ts: startIso,
        end_ts: endIso,
        reason: reason.trim() || undefined,
        case_ref: caseRef.trim() || undefined,
      });
      toast.success("Evidence lock placed — this range is protected from deletion");
      onSaved?.(res);
      onClose?.();
    } catch (e) {
      toast.error(apiError(e, "Could not place the evidence lock"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Lock as evidence"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="heroicons-outline:lock-closed"
            disabled={!rangeValid || saving}
            onClick={save}
          >
            {saving ? "Locking…" : "Place legal hold"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          Recordings overlapping this range are protected from retention &amp; tiering
          deletion until the hold is released.
        </div>
        <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2 text-sm">
          <span className="text-muted">Camera</span>{" "}
          <span className="font-medium text-foreground">{cameraName || cameraId}</span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">From</span>
            <input
              type="datetime-local"
              value={startTs}
              onChange={(e) => setStartTs(e.target.value)}
              className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">To</span>
            <input
              type="datetime-local"
              value={endTs}
              onChange={(e) => setEndTs(e.target.value)}
              className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
            />
          </label>
        </div>
        {!rangeValid && (
          <p className="text-xs text-amber-500">Pick a valid range (To must be after From).</p>
        )}

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">
            Case reference
          </span>
          <input
            type="text"
            value={caseRef}
            onChange={(e) => setCaseRef(e.target.value)}
            placeholder="FIR-2026-0042"
            maxLength={255}
            className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Reason</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Why is this footage being held as evidence?"
            className="w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-muted"
          />
        </label>
      </div>
    </Modal>
  );
}
