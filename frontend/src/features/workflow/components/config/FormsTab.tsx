"use client";

// Forms tab — master (dynamic-form list) / detail (read-only detail, or the
// create/edit FormBuilder). Shared console master/detail: 300px list panel on the
// left, detail/editor/empty on the right.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/kit";
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
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import FormBuilder from "./FormBuilder";
import FormDetail from "./FormDetail";

export default function FormsTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 200 }) });
  const forms = asItems(q.data);

  const [selectedId, setSelectedId] = useState<any>(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState<any>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return forms;
    return forms.filter((f) => (f.name || "").toLowerCase().includes(s) || (f.description || "").toLowerCase().includes(s));
  }, [forms, search]);

  const selected = useMemo(() => (mode === "create" ? null : forms.find((f) => f.form_id === selectedId) || null), [forms, selectedId, mode]);

  useEffect(() => {
    if (mode === "view" && !selected && filtered[0]) setSelectedId(filtered[0].form_id);
  }, [filtered, selected, mode]);

  const remove = useMutation<any>({
    mutationFn: (id: any) => wfApi.forms.remove(id),
    onSuccess: () => { toast.success("Form removed"); qc.invalidateQueries({ queryKey: ["wf-forms"] }); setSelectedId(null); },
    onError: (e) => toast.error(apiError(e)),
  });

  function askDelete(f) {
    setConfirm({ title: "Delete form?", message: `Delete "${f.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(f.form_id); setConfirm(null); } });
  }

  const aside = (
    <ConsolePanel>
      <PanelHeader icon="heroicons-outline:clipboard-document-list" title="Forms" count={forms.length} />
      <PanelSearch value={search} onChange={setSearch} placeholder="Search forms…" />
      <PanelList
        loading={q.isLoading}
        empty={filtered.length === 0}
        emptyText={search.trim() ? "No forms match your search" : "No forms yet"}
      >
          {filtered.map((f) => {
            const isSel = f.form_id === selectedId && mode !== "create";
            return (
              <button key={f.form_id}
                  onClick={() => { setSelectedId(f.form_id); setMode("view"); }}
                  className={`relative w-full flex items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition border ${isSel ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]" : "border-transparent hover:bg-[rgba(96,165,250,.06)]"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-nb-blue" />}
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[rgba(96,165,250,.12)] text-nb-blueb shrink-0">
                    <Icon icon="heroicons-outline:clipboard-document-list" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-nb-ink truncate">{f.name}</span>
                      {f.is_active === false && <span className="text-[9px] rounded-full px-1.5 py-0.5 font-medium uppercase bg-[rgba(10,18,40,.65)] text-nb-faint shrink-0">Off</span>}
                    </span>
                    <span className="block text-[11px] text-nb-faint truncate mt-0.5">{(f.fields?.length || 0)} field(s){f.description ? ` · ${f.description}` : ""}</span>
                  </span>
                </button>
            );
          })}
      </PanelList>

      <PanelFooter>
        <CreateButton label="FORM" onClick={() => { setMode("create"); setSelectedId(null); }} />
      </PanelFooter>
    </ConsolePanel>
  );

  return (
    <>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]" className="h-full">
        {aside}
        <ConsolePanel>
        {mode === "create" || mode === "edit" ? (
          <FormBuilder
              key={mode === "edit" ? selected?.form_id : "new"}
              form={mode === "edit" ? selected : null}
              onCancel={() => setMode("view")}
              onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-forms"] }); setMode("view"); }}
            />
        ) : !selected ? (
          <EmptyPane icon="heroicons-outline:clipboard-document-list" title="No form selected" subtitle="Pick one from the list, or click ＋ NEW FORM to create one." />
        ) : (
          <FormDetail form={selected} onEdit={() => setMode("edit")} onDelete={() => askDelete(selected)} />
        )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />

    </>
  );
}
