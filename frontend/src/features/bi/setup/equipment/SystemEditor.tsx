"use client";

// One system: its name, its (fixed) kind, and the place equipment is added to
// it. The class picker offers only the classes whose vocabulary entry admits
// this system's kind.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton, RowAction } from "@/components/console";
import { ConfirmDialog, Input, Select, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { EquipmentPublic, InfraVocabulary, SiteSystemWithEquipment } from "@/lib/types";

import { classesForKind, type VocabIndex } from "./vocabulary";

export interface SystemEditorProps {
  system: SiteSystemWithEquipment;
  vocab: InfraVocabulary;
  ix: VocabIndex;
  mayWrite: boolean;
  onDeleted: () => void;
  onEquipmentCreated: (e: EquipmentPublic) => void;
}

export default function SystemEditor({ system, vocab, ix, mayWrite, onDeleted, onEquipmentCreated }: Readonly<SystemEditorProps>) {
  const qc = useQueryClient();
  const [form, setForm] = useState<{ name: string; description: string } | null>(null);
  const [adding, setAdding] = useState<{ tag: string; name: string; equipment_class: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["infra-tree", system.site_id] });
  const kind = ix.kinds.get(system.kind);
  const classes = classesForKind(vocab, system.kind);

  const update = useMutation({
    mutationFn: (f: { name: string; description: string }) =>
      siteInfrastructure.updateSystem(system.site_id, system.system_id, {
        name: f.name.trim(),
        description: f.description.trim() || null,
      }),
    onSuccess: () => {
      setForm(null);
      setErr(null);
      invalidate();
    },
    onError: (e) => setErr(apiError(e, "Could not save")),
  });

  const create = useMutation({
    mutationFn: (f: { tag: string; name: string; equipment_class: string }) =>
      siteInfrastructure.createEquipment(system.site_id, {
        system_id: system.system_id,
        tag: f.tag.trim(),
        equipment_class: f.equipment_class,
        name: f.name.trim() || null,
      }),
    onSuccess: (e) => {
      setAdding(null);
      setErr(null);
      invalidate();
      onEquipmentCreated(e);
    },
    onError: (e) => setErr(apiError(e, "Could not add equipment")),
  });

  const remove = useMutation({
    mutationFn: () => siteInfrastructure.deleteSystem(system.site_id, system.system_id),
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
          <h3 className="text-[15px] font-semibold text-nb-ink">{system.name}</h3>
          <p className="text-[11.5px] text-nb-soft" title={kind?.description}>
            {kind?.label ?? system.kind} · {system.equipment.length} equipment
          </p>
          {system.description && <p className="mt-1 text-[11.5px] text-nb-faint">{system.description}</p>}
        </div>
        {mayWrite && !form && (
          <div className="flex shrink-0 items-center gap-0.5">
            <RowAction
              icon="heroicons-outline:plus"
              title="Add equipment"
              onClick={() => {
                setErr(null);
                setAdding({ tag: "", name: "", equipment_class: "" });
              }}
            />
            <RowAction
              icon="heroicons-outline:pencil-square"
              title="Edit system"
              onClick={() => {
                setErr(null);
                setForm({ name: system.name, description: system.description ?? "" });
              }}
            />
            <RowAction
              icon="heroicons-outline:trash"
              tone="danger"
              title="Delete system"
              onClick={() =>
                setConfirm({
                  title: `Delete ${system.name}?`,
                  message: `${system.name} and its ${system.equipment.length} equipment, with every slot and design fact on them, are removed.`,
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
          <div className="grid gap-2 md:grid-cols-2">
            <Input label="System name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <ActionButton type="submit" disabled={update.isPending || !form.name.trim()}>
              {update.isPending ? "Saving…" : "Save"}
            </ActionButton>
            <QuietButton type="button" onClick={() => setForm(null)}>
              Cancel
            </QuietButton>
          </div>
        </form>
      )}

      {adding && (
        <form
          className="space-y-2 rounded-[10px] border border-[rgba(96,165,250,.35)] bg-[rgba(96,165,250,.05)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(adding);
          }}
        >
          <div className="grid gap-2 md:grid-cols-3">
            <Input label="Tag" required value={adding.tag} onChange={(e) => setAdding({ ...adding, tag: e.target.value })} className="font-mono" placeholder="CH-01" />
            <Select
              label="Class"
              value={adding.equipment_class}
              placeholder="Pick a class"
              onChange={(e) => setAdding({ ...adding, equipment_class: e.target.value })}
              options={classes.map((c) => ({ value: c.key, label: c.label }))}
            />
            <Input label="Name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <ActionButton type="submit" disabled={create.isPending || !adding.tag.trim() || !adding.equipment_class}>
              {create.isPending ? "Adding…" : "Add equipment"}
            </ActionButton>
            <QuietButton type="button" onClick={() => setAdding(null)}>
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

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
