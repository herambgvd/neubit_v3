"use client";

// Triggers tab — list of triggers (event match → target SOP) with inline
// create/edit via TriggerForm and delete confirmation.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, idOf } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import TriggerForm from "./TriggerForm";

export default function TriggersTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-triggers"], queryFn: () => wfApi.triggers.list({ limit: 200 }) });
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const triggers = asItems(q.data);
  const sops = asItems(sopsQ.data);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const sopName = (sid) => sops.find((s) => idOf(s, "id", "sop_id") === sid)?.name || "—";

  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? wfApi.triggers.update(id, body) : wfApi.triggers.create(body)),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); setForm(null); },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: (id) => wfApi.triggers.remove(id),
    onSuccess: () => { toast.success("Trigger removed"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Triggers</h3>
          <p className="text-xs text-muted">Match an event → raise an incident from a target SOP.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">Add trigger</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <TriggerForm
            trigger={idOf(form, "id", "trigger_id") ? form : null}
            sops={sops}
            pending={save.isPending}
            onCancel={() => setForm(null)}
            onSubmit={(body) => save.mutate({ id: idOf(form, "id", "trigger_id"), body })}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : triggers.length === 0 && !form ? (
          <p className="text-sm text-muted">No triggers yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {triggers.map((t) => (
              <li key={idOf(t, "id", "trigger_id")} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-amber-500 shrink-0"><Icon icon="heroicons:bolt" className="text-base" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{t.name}</span>
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${t.enabled === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{t.enabled === false ? "Disabled" : "Enabled"}</span>
                  </span>
                  <span className="block text-[11px] text-muted font-mono truncate">
                    {t.event_source ? `${t.event_source}:` : ""}{t.event_type} → {sopName(t.sop_id)}
                    {t.conditions?.length ? ` · ${t.conditions.length} condition(s)` : ""}
                  </span>
                </span>
                <button onClick={() => setForm(t)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                <button onClick={() => setConfirm({ title: "Delete trigger?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(idOf(t, "id", "trigger_id")); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
