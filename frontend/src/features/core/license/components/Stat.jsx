"use client";

// A small icon + label + value stat tile used in the license overview.
import { Icon } from "@iconify/react";

export default function Stat({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-card-border border-card-border px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 bg-blue-500/15 text-blue-400 text-blue-400">
        <Icon icon={icon} className="text-lg" />
      </div>
      <div>
        <p className="text-xs text-muted">{label}</p>
        <p className="font-medium text-foreground text-foreground">{value}</p>
      </div>
    </div>
  );
}
