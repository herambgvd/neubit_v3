"use client";

// Camera / NVR connectivity pill. Presets live in constants.js (STATUS_PRESETS,
// rethemed to v3 tokens). Falls back to "unknown" for any unmapped status.
import { Icon } from "@iconify/react";

import { RECORDER_DOWN_REASONS, STATUS_PRESETS, presetFor } from "../constants";

export interface StatusBadgeProps {
  /** The wire status (CameraStatus / NodeStatus / anything) — unmapped → "unknown". */
  status?: string | null;
  /** Why it is offline when the camera is not the reason (`recorder_offline`):
   *  the pill then names the recorder, not the camera (SCRUM-334). */
  reason?: string | null;
  className?: string;
}

function labelFor(status: string | null | undefined, reason: string | null | undefined): string {
  if (reason && RECORDER_DOWN_REASONS.has(reason)) return "Recorder offline";
  return presetFor(STATUS_PRESETS, status, STATUS_PRESETS.unknown).label;
}

export default function StatusBadge({ status, reason, className = "" }: Readonly<StatusBadgeProps>) {
  const preset = presetFor(STATUS_PRESETS, status, STATUS_PRESETS.unknown);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${preset.cls} ${className}`}
    >
      <Icon icon={preset.icon} className="text-xs" />
      {labelFor(status, reason)}
    </span>
  );
}

// Bare status dot (for dense table rows). NeuBit console dot palette — aligned to
// nb.good/nb.crit/nb.warn (the preset .dot tokens stay for the light-theme pills).
const NB_DOT = {
  online: "bg-nb-good shadow-[0_0_5px_rgb(var(--nb-c-good))]",
  offline: "bg-nb-crit",
  connecting: "bg-nb-warn",
  error: "bg-nb-crit",
  unknown: "bg-nb-warn",
};

export function StatusDot({ status, reason, className = "" }: Readonly<StatusBadgeProps>) {
  const dot = presetFor(NB_DOT, status, NB_DOT.unknown);
  return (
    <span
      title={labelFor(status, reason)}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot} ${className}`}
    />
  );
}
