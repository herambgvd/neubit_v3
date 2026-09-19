"use client";

// Every slot the equipment's CLASS allows, one row each, in three states:
//
//   bound       a device / point pair feeds it
//   unbound     declared (a schedule said the point exists) but no point yet
//   —           not declared on this equipment
//
// A slot outside the class never appears: the list is the vocabulary's, not the
// equipment's, so the operator cannot be offered a `tr` on a pump.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { RowAction } from "@/components/console";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { EquipmentPublic, InfraSlotDef, SlotPublic } from "@/lib/types";

import PointPicker, { type PickedPoint } from "./PointPicker";

export interface SlotListProps {
  equipment: EquipmentPublic;
  defs: InfraSlotDef[];
  mayWrite: boolean;
}

type SlotOp =
  | { kind: "bind"; slot: string; point: PickedPoint }
  | { kind: "unbind"; slot: string }
  | { kind: "remove"; slot: string };

export default function SlotList({ equipment, defs, mayWrite }: Readonly<SlotListProps>) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState<string | null>(null);
  // The failure belongs to the ROW it happened on, and is the server's own
  // sentence — a 409 names the equipment already holding the point.
  const [error, setError] = useState<{ slot: string; message: string } | null>(null);
  const bySlot = new Map<string, SlotPublic>(equipment.slots.map((s) => [s.slot, s]));

  const op = useMutation({
    mutationFn: (o: SlotOp) => {
      const { site_id, equipment_id } = equipment;
      if (o.kind === "remove") return siteInfrastructure.removeSlot(site_id, equipment_id, o.slot);
      const body =
        o.kind === "bind"
          ? { device_tag: o.point.device_tag, point_tag: o.point.point_tag }
          : { device_tag: null, point_tag: null };
      return siteInfrastructure.setSlot(site_id, equipment_id, o.slot, body);
    },
    onSuccess: () => {
      setError(null);
      setPicking(null);
      qc.invalidateQueries({ queryKey: ["infra-tree", equipment.site_id] });
    },
    onError: (e, o) => setError({ slot: o.slot, message: apiError(e, "Could not change this slot") }),
  });

  if (!defs.length) return <p className="text-[11.5px] text-nb-faint">This class has no point slots.</p>;

  return (
    <ul className="divide-y divide-nb-line rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.5)]">
      {defs.map((d) => {
        const s = bySlot.get(d.key);
        return (
          <li key={d.key} className="px-3 py-2" data-testid={`slot-${d.key}`}>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1" title={`${d.key} · ${d.dimension}${d.role ? ` · role ${d.role}` : ""}`}>
                <span className="text-[12.5px] text-nb-ink">{d.label}</span>
                <span className="ml-2 font-mono text-[10.5px] text-nb-faint">{d.key}</span>
              </div>
              <div className="min-w-0 shrink text-right font-mono text-[11.5px]">
                {s?.bound ? (
                  <span className="text-nb-good">
                    {s.device_tag} / {s.point_tag}
                  </span>
                ) : s ? (
                  <span className="text-nb-warn" title="Declared — the point exists on the schedule but is not bound">
                    unbound
                  </span>
                ) : (
                  <span className="text-nb-faint" title="Not declared on this equipment">
                    —
                  </span>
                )}
              </div>
              {mayWrite && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <RowAction
                    icon="heroicons-outline:link"
                    title={s?.bound ? `Rebind ${d.label}` : `Bind ${d.label}`}
                    onClick={() => {
                      setError(null);
                      setPicking(picking === d.key ? null : d.key);
                    }}
                  />
                  {s?.bound && (
                    <RowAction
                      icon="heroicons-outline:x-mark"
                      title={`Unbind ${d.label}`}
                      disabled={op.isPending}
                      onClick={() => op.mutate({ kind: "unbind", slot: d.key })}
                    />
                  )}
                  {s && (
                    <RowAction
                      icon="heroicons-outline:trash"
                      tone="danger"
                      title={`Remove the ${d.label} slot`}
                      disabled={op.isPending}
                      onClick={() => op.mutate({ kind: "remove", slot: d.key })}
                    />
                  )}
                </div>
              )}
            </div>
            {picking === d.key && (
              <PointPicker
                siteId={equipment.site_id}
                busy={op.isPending}
                onPick={(point) => op.mutate({ kind: "bind", slot: d.key, point })}
                onCancel={() => setPicking(null)}
              />
            )}
            {error?.slot === d.key && (
              <p role="alert" className="mt-1.5 text-[11.5px] text-nb-crit">
                {error.message}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
