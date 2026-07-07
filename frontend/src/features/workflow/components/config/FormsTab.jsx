"use client";

// Forms tab — list of dynamic forms with inline create/edit via FormBuilder and
// delete confirmation.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import FormBuilder from "./FormBuilder";

export default function FormsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 200 }) });
  const forms = asItems(q.data);
  const [form, setForm] = useState(null); // {} for new, form obj for edit
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => wfApi.forms.remove(id),
    onSuccess: () => { toast.success("Form removed"); qc.invalidateQueries({ queryKey: ["wf-forms"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Forms</h3>
          <p className="text-xs text-muted">Structured data operators fill when advancing an incident through a transition.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">New form</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <FormBuilder
            form={form.form_id ? form : null}
            onCancel={() => setForm(null)}
            onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-forms"] }); setForm(null); }}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : forms.length === 0 && !form ? (
          <p className="text-sm text-muted">No forms yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {forms.map((f) => (
              <li key={f.form_id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500 shrink-0"><Icon icon="heroicons-outline:clipboard-document-list" className="text-base" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{f.name}</span>
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${f.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{f.is_active === false ? "Inactive" : "Active"}</span>
                  </span>
                  <span className="block text-[11px] text-muted">{(f.fields?.length || 0)} field(s){f.description ? ` · ${f.description}` : ""}</span>
                </span>
                <button onClick={() => setForm(f)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                <button onClick={() => setConfirm({ title: "Delete form?", message: `Delete "${f.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(f.form_id); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
