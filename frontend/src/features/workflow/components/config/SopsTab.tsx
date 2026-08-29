"use client";

// SOPs tab — master (SOP list) / detail (metadata + the visual state-machine
// canvas). Built on the shared console primitives (components/console) so it wears
// the same frame as Users / Sites / Ingest; SOP rows + canvas stay bespoke.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelSearch,
  PanelList,
  PanelFooter,
  CreateButton,
  EmptyPane,
} from "@/components/console";
import { ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { titleize, asItems, idOf } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import SopForm from "./SopForm";
import SopBuilder from "./SopBuilder";

const sopId = (s) => idOf(s, "id", "sop_id");

export default function SopsTab() {
  const qc = useQueryClient();
  const sopsQ = useQuery<any>({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);

  const [selectedId, setSelectedId] = useState<any>(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState<any>(null);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return sops;
    return sops.filter((x) => (x.name || "").toLowerCase().includes(s) || (x.description || "").toLowerCase().includes(s));
  }, [sops, q]);

  const selected = useMemo(() => sops.find((s) => sopId(s) === selectedId) || null, [sops, selectedId]);

  useEffect(() => {
    if (mode === "view" && !selected && filtered[0]) setSelectedId(sopId(filtered[0]));
  }, [filtered, selected, mode]);

  const remove = useMutation<any>({
    mutationFn: (id: any) => wfApi.sops.remove(id),
    onSuccess: () => {
      toast.success("SOP removed");
      qc.invalidateQueries({ queryKey: ["wf-sops"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const aside = (
    <ConsolePanel>
      <PanelHeader icon="heroicons:rectangle-stack" title="SOPs" count={sops.length} />
      <PanelSearch value={q} onChange={setQ} placeholder="Search SOPs…" />
      <PanelList
        loading={sopsQ.isLoading}
        empty={filtered.length === 0}
        emptyText={q.trim() ? "No SOPs match your search" : "No SOPs yet"}
      >
        {filtered.map((s) => {
          const isSel = sopId(s) === selectedId && mode !== "create";
          return (
            <button
              key={sopId(s)}
              onClick={() => { setSelectedId(sopId(s)); setMode("view"); }}
              className={`relative w-full flex items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition border ${isSel ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]" : "border-transparent hover:bg-[rgba(96,165,250,.06)]"}`}
            >
              {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-nb-blue" />}
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[rgba(96,165,250,.12)] text-nb-blueb shrink-0">
                <Icon icon="heroicons:rectangle-stack" className="text-base" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-nb-ink truncate">{s.name}</span>
                <span className="block text-[11px] text-nb-faint">
                  {typeof s.version === "number" ? `v${s.version} · ` : ""}
                  {titleize(s.default_priority || "medium")}
                  {s.is_active === false ? " · Inactive" : ""}
                </span>
              </span>
            </button>
          );
        })}
      </PanelList>

      <PanelFooter>
        <CreateButton label="SOP" onClick={() => { setMode("create"); setSelectedId(null); }} />
      </PanelFooter>
    </ConsolePanel>
  );

  return (
    <>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]" className="h-full">
        {aside}
        <ConsolePanel>
        {mode === "create" || mode === "edit" ? (
          <SopForm
            sop={mode === "edit" ? selected : null}
            onCancel={() => setMode("view")}
            onSaved={(saved) => {
              qc.invalidateQueries({ queryKey: ["wf-sops"] });
              const id = idOf(saved, "id", "sop_id");
              if (id) setSelectedId(id);
              setMode("view");
            }}
          />
        ) : !selected ? (
          <EmptyPane icon="heroicons:rectangle-stack" title="No SOP selected" subtitle="Pick one from the list, or click ＋ NEW SOP to create one." />
        ) : (
          <SopBuilder
            key={sopId(selected)}
            sop={selected}
            onSaved={() => qc.invalidateQueries({ queryKey: ["wf-sops"] })}
            onDelete={() =>
              setConfirm({
                title: "Delete SOP?",
                message: `Delete "${selected.name}" and its states/transitions?`,
                confirmLabel: "Delete",
                onConfirm: () => { remove.mutate(sopId(selected)); setConfirm(null); },
              })
            }
          />
        )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </>
  );
}
