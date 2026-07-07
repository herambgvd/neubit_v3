"use client";

// Notification templates tab — list of reusable subject/body templates rendered
// with incident variables, with inline create/edit via TemplateForm and delete
// confirmation.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import TemplateForm from "./TemplateForm";

export default function NotificationTemplatesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-templates"], queryFn: () => wfApi.notifications.templates.list({ limit: 200 }) });
  const templates = asItems(q.data);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => wfApi.notifications.templates.remove(id),
    onSuccess: () => { toast.success("Template removed"); qc.invalidateQueries({ queryKey: ["wf-templates"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Notification templates</h3>
          <p className="text-xs text-muted">Reusable subject/body messages rendered with incident variables.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">New template</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <TemplateForm
            template={form.template_id ? form : null}
            onCancel={() => setForm(null)}
            onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-templates"] }); setForm(null); }}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : templates.length === 0 && !form ? (
          <p className="text-sm text-muted">No templates yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {templates.map((t) => (
              <li key={t.template_id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-purple-500/10 text-purple-500 shrink-0"><Icon icon="heroicons-outline:bell-alert" className="text-base" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{t.name}</span>
                    <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted uppercase">{t.channel_type}</span>
                    {t.is_active === false && <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted">Inactive</span>}
                  </span>
                  <span className="block text-[11px] text-muted truncate">{t.subject || t.body?.slice(0, 80)}</span>
                </span>
                <button onClick={() => setForm(t)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                <button onClick={() => setConfirm({ title: "Delete template?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(t.template_id); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
