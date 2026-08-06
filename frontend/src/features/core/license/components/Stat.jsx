"use client";

// A small icon + label + value stat tile used in the license overview.
import { Icon } from "@iconify/react";

export default function Stat({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-nb-line px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-nb-blue/12 text-nb-blueb">
        <Icon icon={icon} className="text-lg" />
      </div>
      <div>
        <p className="text-xs text-nb-muted">{label}</p>
        <p className="font-medium text-nb-ink">{value}</p>
      </div>
    </div>
  );
}
