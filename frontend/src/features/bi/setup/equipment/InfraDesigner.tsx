"use client";

// INFRA DESIGNER — Building Intelligence → Setup → Equipment: the systems in a
// building, the equipment in each, and the gateway point behind each slot.
//
// It is BI configuration, not site administration: nothing in Sites, Floors,
// Zones or the VMS reads a chiller's TR or ΔT band, so it lives in BI's Setup
// and rides BI's gate — `bi.read` + the `analytics` module to read, `bi.manage`
// to write (backend/core/app/sites/infrastructure/router.py). The rows are
// still stored under the site; BI sends an operator here with
// `infraDesignerHref` when a fact is missing.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { IconButton, LoadingBlock } from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { InfraVocabulary, InfrastructureTree } from "@/lib/types";

import { MODULE, PERM_MANAGE, PERM_READ } from "../../constants";

import EquipmentEditor from "./EquipmentEditor";
import NewSystemForm from "./NewSystemForm";
import ScheduleImport from "./ScheduleImport";
import SystemEditor from "./SystemEditor";
import SystemTree, { type TreeSelection } from "./SystemTree";
import { indexVocabulary } from "./vocabulary";

export interface InfraDesignerProps {
  siteId: string;
  /** Open on this equipment — the deep link Building Intelligence uses. */
  initialEquipmentId?: string | null;
}

export default function InfraDesigner({ siteId, initialEquipmentId }: Readonly<InfraDesignerProps>) {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const mayWrite = mayRead && can(PERM_MANAGE);

  const vocabQ = useQuery<InfraVocabulary>({
    queryKey: ["infra-vocabulary"],
    queryFn: siteInfrastructure.vocabulary,
    staleTime: Infinity,
    enabled: mayRead,
  });
  const treeQ = useQuery<InfrastructureTree>({
    queryKey: ["infra-tree", siteId],
    queryFn: () => siteInfrastructure.tree(siteId),
    enabled: mayRead,
  });

  const [selected, setSelected] = useState<TreeSelection>(
    initialEquipmentId ? { type: "equipment", id: initialEquipmentId } : null,
  );
  const [creatingSystem, setCreatingSystem] = useState(false);
  const [importing, setImporting] = useState(false);

  const ix = useMemo(() => (vocabQ.data ? indexVocabulary(vocabQ.data) : null), [vocabQ.data]);
  const systems = useMemo(() => treeQ.data?.systems ?? [], [treeQ.data]);

  if (!mayRead) {
    return (
      <p className="px-6 py-5 text-[11.5px] text-nb-faint">
        Needs <span className="font-mono">bi.read</span> and the analytics module.
      </p>
    );
  }
  if (vocabQ.isLoading || treeQ.isLoading) return <LoadingBlock label="Loading equipment…" />;
  const failure = vocabQ.error ?? treeQ.error;
  if (failure || !vocabQ.data || !ix) {
    return <p className="px-6 py-5 text-sm text-nb-crit">{apiError(failure, "Could not load the equipment registry")}</p>;
  }
  const vocab = vocabQ.data;

  const equipmentCount = systems.reduce((n, s) => n + s.equipment.length, 0);
  const slots = systems.flatMap((s) => s.equipment.flatMap((e) => e.slots));
  const bound = slots.filter((s) => s.bound).length;

  const selSystem = selected?.type === "system" ? systems.find((s) => s.system_id === selected.id) : undefined;
  const selEquipment =
    selected?.type === "equipment"
      ? systems.flatMap((s) => s.equipment).find((e) => e.equipment_id === selected.id)
      : undefined;

  return (
    <div className="space-y-4 px-6 py-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-nb-soft">
          <span>{systems.length} system(s)</span>
          <span className="text-nb-faint">·</span>
          <span>{equipmentCount} equipment</span>
          <span className="text-nb-faint">·</span>
          <span title="Slots bound to a gateway point, of all declared slots">
            {bound}/{slots.length} slots bound
          </span>
        </div>
        {mayWrite && (
          <div className="flex items-center gap-1.5">
            <IconButton
              icon="heroicons-outline:arrow-up-tray"
              title="Import I/O schedule"
              onClick={() => setImporting(true)}
            />
            <IconButton
              icon="heroicons:plus"
              title="New system"
              onClick={() => {
                setSelected(null);
                setCreatingSystem(true);
              }}
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="min-w-0">
          {systems.length ? (
            <SystemTree
              systems={systems}
              ix={ix}
              selected={selected}
              onSelect={(s) => {
                setCreatingSystem(false);
                setSelected(s);
              }}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-nb-line px-4 py-8 text-center text-[12px] text-nb-muted">
              No systems in this building
            </p>
          )}
        </div>

        <div className="min-w-0 rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-4">
          {creatingSystem && mayWrite ? (
            <NewSystemForm
              siteId={siteId}
              vocab={vocab}
              onCancel={() => setCreatingSystem(false)}
              onCreated={(s) => {
                setCreatingSystem(false);
                setSelected({ type: "system", id: s.system_id });
              }}
            />
          ) : selEquipment ? (
            <EquipmentEditor
              key={selEquipment.equipment_id}
              equipment={selEquipment}
              systems={systems}
              ix={ix}
              mayWrite={mayWrite}
              onDeleted={() => setSelected(null)}
            />
          ) : selSystem ? (
            <SystemEditor
              key={selSystem.system_id}
              system={selSystem}
              vocab={vocab}
              ix={ix}
              mayWrite={mayWrite}
              onDeleted={() => setSelected(null)}
              onEquipmentCreated={(e) => setSelected({ type: "equipment", id: e.equipment_id })}
            />
          ) : (
            <p className="py-8 text-center text-[12px] text-nb-muted">Pick a system or a piece of equipment</p>
          )}
        </div>
      </div>

      {importing && mayWrite && <ScheduleImport siteId={siteId} ix={ix} onClose={() => setImporting(false)} />}
    </div>
  );
}
