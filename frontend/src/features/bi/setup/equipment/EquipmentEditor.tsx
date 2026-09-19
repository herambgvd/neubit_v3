"use client";

// One piece of equipment: its identity (tag, name, which system), its point
// slots and its nameplate. The CLASS is shown and never offered for edit — the
// server refuses the change (a mis-classified unit is deleted and re-created,
// because its slots and facts were admitted against the old class).
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton, RowAction } from "@/components/console";
import { ConfirmDialog, Input, Select, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { EquipmentPublic, SiteSystemWithEquipment } from "@/lib/types";

import DesignFacts from "./DesignFacts";
import SlotList from "./SlotList";
import { factsOf, slotsOf, type VocabIndex } from "./vocabulary";

export interface EquipmentEditorProps {
  equipment: EquipmentPublic;
  systems: SiteSystemWithEquipment[];
  ix: VocabIndex;
  mayWrite: boolean;
  onDeleted: () => void;
}

export default function EquipmentEditor({ equipment, systems, ix, mayWrite, onDeleted }: Readonly<EquipmentEditorProps>) {
  const qc = useQueryClient();
  const cls = ix.classes.get(equipment.equipment_class);
  const system = systems.find((s) => s.system_id === equipment.system_id);
  const [form, setForm] = useState<{ tag: string; name: string; system_id: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["infra-tree", equipment.site_id] });

  // A unit may move only to a system whose kind admits its class.
  const homes = systems.filter((s) => cls?.system_kinds.includes(s.kind));

  const update = useMutation({
    mutationFn: (f: { tag: string; name: string; system_id: string }) =>
      siteInfrastructure.updateEquipment(equipment.site_id, equipment.equipment_id, {
        tag: f.tag.trim(),
        name: f.name.trim() || null,
        system_id: f.system_id,
      }),
    onSuccess: () => {
      setForm(null);
      setErr(null);
      invalidate();
    },
    onError: (e) => setErr(apiError(e, "Could not save")),
  });

  const remove = useMutation({
    mutationFn: () => siteInfrastructure.deleteEquipment(equipment.site_id, equipment.equipment_id),
    onSuccess: () => {
      setConfirm(null);
      invalidate();
      onDeleted();
    },
    onError: (e) => {
      setConfirm(null);
      setErr(apiError(e, "Could not delete"));
    },
  });

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-mono text-[15px] font-semibold text-nb-ink">{equipment.tag}</h3>
          <p className="text-[11.5px] text-nb-soft">
            {equipment.name ? `${equipment.name} · ` : ""}
            {cls?.label ?? equipment.equipment_class}
            {system ? ` · ${system.name}` : ""}
          </p>
        </div>
        {mayWrite && !form && (
          <div className="flex shrink-0 items-center gap-0.5">
            <RowAction
              icon="heroicons-outline:pencil-square"
              title="Edit equipment"
              onClick={() => {
                setErr(null);
                setForm({ tag: equipment.tag, name: equipment.name ?? "", system_id: equipment.system_id });
              }}
            />
            <RowAction
              icon="heroicons-outline:trash"
              tone="danger"
              title="Delete equipment"
              onClick={() =>
                setConfirm({
                  title: `Delete ${equipment.tag}?`,
                  message: `${equipment.tag}, its ${equipment.slots.length} slot(s) and its design facts are removed.`,
                  confirmLabel: "Delete",
                  onConfirm: () => remove.mutate(),
                })
              }
            />
          </div>
        )}
      </header>

      {form && (
        <form
          className="space-y-2 rounded-[10px] border border-nb-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate(form);
          }}
        >
          <div className="grid gap-2 md:grid-cols-3">
            <Input label="Tag" required value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} className="font-mono" />
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select
              label="System"
              value={form.system_id}
              onChange={(e) => setForm({ ...form, system_id: e.target.value })}
              options={homes.map((s) => ({ value: s.system_id, label: s.name }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <ActionButton type="submit" disabled={update.isPending || !form.tag.trim()}>
              {update.isPending ? "Saving…" : "Save"}
            </ActionButton>
            <QuietButton type="button" onClick={() => setForm(null)}>
              Cancel
            </QuietButton>
          </div>
        </form>
      )}
      {err && (
        <p role="alert" className="text-[11.5px] text-nb-crit">
          {err}
        </p>
      )}

      <section className="space-y-1.5">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-muted">Point slots</h4>
        <SlotList key={equipment.equipment_id} equipment={equipment} defs={slotsOf(ix, cls)} mayWrite={mayWrite} />
      </section>

      <section className="space-y-1.5">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-muted">Design</h4>
        <DesignFacts key={equipment.equipment_id} equipment={equipment} facts={factsOf(ix, cls)} mayWrite={mayWrite} />
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
