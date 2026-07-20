"use client";

// Forms tab — master (dynamic-form list) / detail (read-only detail, or the
// create/edit FormBuilder). v2 master-detail layout: 360px ListPanel on the
// left, detail/editor/empty on the right.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import FormBuilder from "./FormBuilder";
import FormDetail from "./FormDetail";

export default function FormsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 200 }) });
  const forms = asItems(q.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);
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

  const remove = useMutation({
    mutationFn: (id) => wfApi.forms.remove(id),
    onSuccess: () => { toast.success("Form removed"); qc.invalidateQueries({ queryKey: ["wf-forms"] }); setSelectedId(null); },
    onError: (e) => toast.error(apiError(e)),
  });

  function askDelete(f) {
    setConfirm({ title: "Delete form?", message: `Delete "${f.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(f.form_id); setConfirm(null); } });
  }

  const aside = (
    <ListPanel
      title="Forms"
      count={forms.length}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search forms…"
      action={
        <Button variant="success" icon="heroicons-outline:plus" onClick={() => { setMode("create"); setSelectedId(null); }} className="!px-2.5 !py-1 text-xs">New</Button>
      }
    >
      {q.isLoading ? (
        <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted">{search.trim() ? "No forms match your search." : "No forms yet."}</div>
      ) : (
        <ul className="divide-y divide-card-border">
          {filtered.map((f) => {
            const isSel = f.form_id === selectedId && mode !== "create";
            return (
              <li key={f.form_id} className="relative">
                <button
                  onClick={() => { setSelectedId(f.form_id); setMode("view"); }}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${isSel ? "bg-hover" : "hover:bg-hover"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-indigo-500" />}
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500 shrink-0">
                    <Icon icon="heroicons-outline:clipboard-document-list" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground truncate">{f.name}</span>
                      {f.is_active === false && <span className="text-[9px] rounded-full px-1.5 py-0.5 font-medium uppercase bg-hover text-muted shrink-0">Off</span>}
                    </span>
                    <span className="block text-[11px] text-muted truncate mt-0.5">{(f.fields?.length || 0)} field(s){f.description ? ` · ${f.description}` : ""}</span>
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
    <MasterDetail fill aside={aside} gridCols="lg:grid-cols-[360px_1fr]" className="min-h-0 flex-1">
      <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-full flex flex-col">
        {mode === "create" || mode === "edit" ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            <FormBuilder
              key={mode === "edit" ? selected?.form_id : "new"}
              form={mode === "edit" ? selected : null}
              onCancel={() => setMode("view")}
              onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-forms"] }); setMode("view"); }}
            />
          </div>
        ) : !selected ? (
          <EmptyDetail icon="heroicons-outline:clipboard-document-list" title="No form selected" subtitle="Pick one from the list or click New." />
        ) : (
          <FormDetail form={selected} onEdit={() => setMode("edit")} onDelete={() => askDelete(selected)} />
        )}
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </MasterDetail>
  );
}
