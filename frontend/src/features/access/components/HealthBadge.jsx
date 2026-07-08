"use client";

// Instance connectivity pill. Ported from neubit_v2's health-badge.jsx; presets
// live in constants.js (rethemed to v3 tokens). Handles v3 statuses
// online|offline|unknown as well as v2's active|inactive|error aliases.
import { Icon } from "@iconify/react";

import { HEALTH_PRESETS } from "../constants";

export default function HealthBadge({ status }) {
  const preset = HEALTH_PRESETS[status] || HEALTH_PRESETS.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${preset.cls}`}
    >
      <Icon icon={preset.icon} className="text-xs" />
      {preset.label}
    </span>
  );
}
