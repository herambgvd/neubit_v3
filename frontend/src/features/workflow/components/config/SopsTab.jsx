"use client";

// SOPs tab — master (SOP list) / detail (metadata + the visual state-machine
// canvas). Uses the shared MasterDetail + ListPanel scaffold for the two-pane
// layout; the SOP rows + detail header stay bespoke (color accent, canvas).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize, asItems, idOf } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import SopForm from "./SopForm";
import SopCanvas from "../../sop-designer/SopCanvas";

const sopId = (s) => idOf(s, "id", "sop_id");

export default function SopsTab() {
  const qc = useQueryClient();
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);

  const selected = useMemo(() => sops.find((s) => sopId(s) === selectedId) || null, [sops, selectedId]);

  useEffect(() => {
    if (mode === "view" && !selected && sops[0]) setSelectedId(sopId(sops[0]));
  }, [sops, selected, mode]);

  const remove = useMutation({
    mutationFn: (id) => wfApi.sops.remove(id),
    onSuccess: () => {
      toast.success("SOP removed");
      qc.invalidateQueries({ queryKey: ["wf-sops"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const aside = (
    <ListPanel
      title="SOPs"
      count={sops.length}
      action={
        <Button variant="success" icon="heroicons-outline:plus" onClick={() => setMode("create")} className="!px-2.5 !py-1 text-xs">
          New
        </Button>
      }
    >
      {sopsQ.isLoading ? (
        <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading…</div>
      ) : sops.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted">No SOPs yet. Click <b>New</b>.</div>
      ) : (
        <ul className="divide-y divide-card-border">
          {sops.map((s) => {
            const isSel = sopId(s) === selectedId && mode !== "create";
            return (
              <li key={sopId(s)} className="relative">
                <button
                  onClick={() => { setSelectedId(sopId(s)); setMode("view"); }}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${isSel ? "bg-hover" : "hover:bg-hover"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0">
                    <Icon icon="heroicons:rectangle-stack" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground truncate">{s.name}</span>
                    <span className="block text-[11px] text-muted">
                      {typeof s.version === "number" ? `v${s.version} · ` : ""}
                      {titleize(s.default_priority || "medium")}
                      {s.is_active === false ? " · Inactive" : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </ListPanel>
  );

  return (
    <MasterDetail aside={aside} gridCols="lg:grid-cols-[20rem_1fr]" className="min-h-[60vh]">
      <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
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
          <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
            <Icon icon="heroicons:rectangle-stack" className="text-3xl text-muted opacity-60" />
            <div className="mt-3 text-sm font-semibold text-foreground">No SOP selected</div>
          </div>
        ) : (
          <SopDetail
            sop={selected}
            sopId={sopId(selected)}
            onEdit={() => setMode("edit")}
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
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </MasterDetail>
  );
}

function SopDetail({ sop, sopId, onEdit, onDelete }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground truncate">{sop.name}</h2>
          {sop.description && <p className="mt-0.5 text-xs text-muted">{sop.description}</p>}
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted flex-wrap">
            {typeof sop.version === "number" && <span>v{sop.version}</span>}
            <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 capitalize">{titleize(sop.default_priority || "medium")}</span>
            {sop.sla_hours != null && <span>SLA {sop.sla_hours}h</span>}
            <span className={`rounded-full px-2 py-0.5 ${sop.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>
              {sop.is_active === false ? "Inactive" : "Active"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <SopCanvas key={sopId} sopId={sopId} />
      </div>
    </div>
  );
}
