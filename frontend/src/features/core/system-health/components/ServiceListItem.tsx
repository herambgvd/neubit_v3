"use client";

// One service row in the health list: what it is, whether it is up, and what it
// is costing. Selecting it opens that service's logs in the pane beside.
import { Icon } from "@iconify/react";

import type { ServiceOut } from "../../types";
import { serviceState } from "../serviceFormat";

export interface ServiceListItemProps {
  service: ServiceOut;
  selected: boolean;
  onSelect: () => void;
}

export default function ServiceListItem({ service, selected, onSelect }: ServiceListItemProps) {
  const state = serviceState(service);
  const mem = service.mem_used_mb != null ? `${Math.round(service.mem_used_mb)} MB` : null;
  const cpu = service.cpu_pct != null ? `${service.cpu_pct.toFixed(1)}%` : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`w-full rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-nb-blue/50 bg-nb-blue/10"
          : "border-nb-line bg-white/[.02] hover:border-nb-blue/30 hover:bg-white/[.05]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${state.dot}`}
          aria-hidden="true"
        />
        <span className="truncate font-mono text-[12.5px] text-nb-ink">{service.name}</span>
        <span className={`ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-[.8px] ${state.tone}`}>
          {state.label}
        </span>
      </div>
      {(cpu || mem) && (
        <div className="mt-1 flex items-center gap-3 pl-[15px] font-mono text-[10.5px] text-nb-faint">
          {cpu && (
            <span className="flex items-center gap-1">
              <Icon icon="heroicons-outline:cpu-chip" className="text-[11px]" /> {cpu}
            </span>
          )}
          {mem && (
            <span className="flex items-center gap-1">
              <Icon icon="heroicons-outline:circle-stack" className="text-[11px]" /> {mem}
            </span>
          )}
        </div>
      )}
    </button>
  );
}
