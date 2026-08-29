"use client";

// Camera / NVR connectivity pill. Presets live in constants.js (STATUS_PRESETS,
// rethemed to v3 tokens). Falls back to "unknown" for any unmapped status.
import { Icon } from "@iconify/react";

import { STATUS_PRESETS } from "../constants";

export default function StatusBadge({ status, className = "" }: any) {
  const preset = STATUS_PRESETS[status] || STATUS_PRESETS.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${preset.cls} ${className}`}
    >
      <Icon icon={preset.icon} className="text-xs" />
      {preset.label}
    </span>
  );
}

// Bare status dot (for dense table rows). NeuBit console dot palette — aligned to
// nb.good/nb.crit/nb.warn (the preset .dot tokens stay for the light-theme pills).
const NB_DOT = {
  online: "bg-nb-good shadow-[0_0_5px_#34d399]",
  offline: "bg-nb-crit",
  connecting: "bg-nb-warn",
  error: "bg-nb-crit",
  unknown: "bg-nb-warn",
};

export function StatusDot({ status, className = "" }: any) {
  const preset = STATUS_PRESETS[status] || STATUS_PRESETS.unknown;
  const dot = NB_DOT[status] || NB_DOT.unknown;
  return (
    <span
      title={preset.label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot} ${className}`}
    />
  );
}
