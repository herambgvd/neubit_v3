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
import SopBuilder from "./SopBuilder";

const sopId = (s) => idOf(s, "id", "sop_id");

export default function SopsTab() {
  const qc = useQueryClient();
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);
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
      search={q}
      onSearch={setQ}
      searchPlaceholder="Search SOPs…"
      action={
        <button onClick={() => { setMode("create"); setSelectedId(null); }} className="inline-flex items-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 py-2 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)]">
          <Icon icon="heroicons-outline:plus" /> New
        </button>
      }
    >
      {sopsQ.isLoading ? (
        <div className="px-4 py-8 flex items-center gap-2 text-sm text-nb-faint"><Spinner className="!h-4 !w-4" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-nb-faint">{q.trim() ? "No SOPs match your search." : <>No SOPs yet. Click <b>New</b>.</>}</div>
      ) : (
        <ul className="divide-y divide-nb-line">
          {filtered.map((s) => {
            const isSel = sopId(s) === selectedId && mode !== "create";
            return (
              <li key={sopId(s)} className="relative">
                <button
                  onClick={() => { setSelectedId(sopId(s)); setMode("view"); }}
                  className={`w-full flex items-start gap-3 rounded-[10px] px-4 py-3 text-left transition border ${isSel ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]" : "border-transparent hover:bg-[rgba(96,165,250,.06)]"}`}
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
              </li>
            );
          })}
        </ul>
      )}
    </ListPanel>
  );

  return (
    <MasterDetail aside={aside} gridCols="lg:grid-cols-[360px_1fr]" className="min-h-[60vh]">
      <section className="rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] overflow-hidden min-h-0 flex flex-col">
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
          <EmptyDetail icon="heroicons:rectangle-stack" title="No SOP selected" subtitle="Pick one from the list or click New." />
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
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </MasterDetail>
  );
}
