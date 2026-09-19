"use client";

// The site's registry as one tree: SYSTEM → EQUIPMENT → SLOT. Each equipment
// row carries the two things an operator scans for — how many of its declared
// slots are bound, and, where the class has one, whether a ΔT design band is on
// file (the thing Building Intelligence judges a chiller against).
import { useState } from "react";
import { Icon } from "@iconify/react";

import type { EquipmentPublic, SiteSystemWithEquipment } from "@/lib/types";

import { DT_BAND, type VocabIndex } from "./vocabulary";

export type TreeSelection = { type: "system" | "equipment"; id: string } | null;

export interface SystemTreeProps {
  systems: SiteSystemWithEquipment[];
  ix: VocabIndex;
  selected: TreeSelection;
  onSelect: (s: TreeSelection) => void;
}

/** True when the class carries a ΔT band and this unit has none on file. */
export function missingBand(e: EquipmentPublic, ix: VocabIndex): boolean {
  const facts = ix.classes.get(e.equipment_class)?.facts ?? [];
  return DT_BAND.every((k) => facts.includes(k)) && DT_BAND.some((k) => e.design[k] == null);
}

export default function SystemTree({ systems, ix, selected, onSelect }: Readonly<SystemTreeProps>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  return (
    <ul className="space-y-1.5" aria-label="Systems">
      {systems.map((sys) => {
        const isCollapsed = collapsed.has(sys.system_id);
        const on = selected?.type === "system" && selected.id === sys.system_id;
        return (
          <li key={sys.system_id}>
            <div
              className={`flex items-center gap-1 rounded-[8px] border px-1.5 py-1 ${
                on ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.12)]" : "border-transparent hover:bg-white/5"
              }`}
            >
              <button
                type="button"
                aria-label={isCollapsed ? `Expand ${sys.name}` : `Collapse ${sys.name}`}
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => flip(c, sys.system_id))}
                className="grid h-6 w-6 place-items-center text-nb-faint hover:text-nb-ink"
              >
                <Icon icon={isCollapsed ? "heroicons-outline:chevron-right" : "heroicons-outline:chevron-down"} className="text-xs" />
              </button>
              <button
                type="button"
                onClick={() => onSelect({ type: "system", id: sys.system_id })}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={ix.kinds.get(sys.kind)?.description}
              >
                <Icon icon="heroicons-outline:server-stack" className="shrink-0 text-sm text-nb-blueb" />
                <span className="truncate text-[12.5px] font-semibold text-nb-ink">{sys.name}</span>
                <span className="truncate text-[10.5px] text-nb-faint">{ix.kinds.get(sys.kind)?.label ?? sys.kind}</span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-nb-faint">{sys.equipment.length}</span>
              </button>
            </div>

            {!isCollapsed && (
              <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-nb-line pl-2">
                {sys.equipment.length === 0 && <li className="px-2 py-1 text-[11px] text-nb-faint">No equipment</li>}
                {sys.equipment.map((e) => {
                  const eOn = selected?.type === "equipment" && selected.id === e.equipment_id;
                  const bound = e.slots.filter((s) => s.bound).length;
                  const expanded = open.has(e.equipment_id);
                  return (
                    <li key={e.equipment_id}>
                      <div
                        className={`flex items-center gap-1 rounded-[8px] border px-1 py-0.5 ${
                          eOn ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.12)]" : "border-transparent hover:bg-white/5"
                        }`}
                      >
                        <button
                          type="button"
                          aria-label={expanded ? `Hide slots of ${e.tag}` : `Show slots of ${e.tag}`}
                          aria-expanded={expanded}
                          onClick={() => setOpen((o) => flip(o, e.equipment_id))}
                          disabled={!e.slots.length}
                          className="grid h-6 w-6 place-items-center text-nb-faint hover:text-nb-ink disabled:opacity-30"
                        >
                          <Icon icon={expanded ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="text-xs" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelect({ type: "equipment", id: e.equipment_id })}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <span className="shrink-0 font-mono text-[12px] text-nb-ink">{e.tag}</span>
                          <span className="truncate text-[11px] text-nb-soft">
                            {e.name ? `${e.name} · ` : ""}
                            {ix.classes.get(e.equipment_class)?.label ?? e.equipment_class}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {missingBand(e, ix) && (
                              <span
                                className="rounded-full border border-[rgba(251,191,36,.45)] px-1.5 text-[10px] text-nb-warn"
                                title="No design ΔT band on file — Building Intelligence has nothing to judge this unit's ΔT against"
                              >
                                no ΔT band
                              </span>
                            )}
                            <span
                              className={`font-mono text-[10.5px] ${bound < e.slots.length ? "text-nb-warn" : "text-nb-faint"}`}
                              title={`${bound} of ${e.slots.length} declared slots bound to a point`}
                            >
                              {e.slots.length ? `${bound}/${e.slots.length}` : "no slots"}
                            </span>
                          </span>
                        </button>
                      </div>
                      {expanded && (
                        <ul className="ml-7 space-y-0.5 py-0.5">
                          {e.slots.map((s) => (
                            <li key={s.slot} className="flex items-center gap-2 text-[11px]">
                              <span className="w-28 shrink-0 truncate text-nb-soft" title={s.slot}>
                                {ix.slots.get(s.slot)?.label ?? s.slot}
                              </span>
                              {s.bound ? (
                                <span className="truncate font-mono text-nb-good">
                                  {s.device_tag} / {s.point_tag}
                                </span>
                              ) : (
                                <span className="text-nb-warn">unbound</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
