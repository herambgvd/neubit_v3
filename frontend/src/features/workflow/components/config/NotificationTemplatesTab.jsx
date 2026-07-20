"use client";

// Notification templates tab — master (template list) / detail (read-only
// detail, or the create/edit TemplateForm). v2 master-detail layout: 360px
// ListPanel on the left, detail/editor/empty on the right.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import TemplateForm from "./TemplateForm";
import TemplateDetail from "./TemplateDetail";

export default function NotificationTemplatesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-templates"], queryFn: () => wfApi.notifications.templates.list({ limit: 200 }) });
  const templates = asItems(q.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return templates;
    return templates.filter((t) => (t.name || "").toLowerCase().includes(s) || (t.channel_type || "").toLowerCase().includes(s));
  }, [templates, search]);

  const selected = useMemo(() => (mode === "create" ? null : templates.find((t) => t.template_id === selectedId) || null), [templates, selectedId, mode]);

  useEffect(() => {
    if (mode === "view" && !selected && filtered[0]) setSelectedId(filtered[0].template_id);
  }, [filtered, selected, mode]);

  const remove = useMutation({
    mutationFn: (id) => wfApi.notifications.templates.remove(id),
    onSuccess: () => { toast.success("Template removed"); qc.invalidateQueries({ queryKey: ["wf-templates"] }); setSelectedId(null); },
    onError: (e) => toast.error(apiError(e)),
  });

  function askDelete(t) {
    setConfirm({ title: "Delete template?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(t.template_id); setConfirm(null); } });
  }

  const aside = (
    <ListPanel
      title="Templates"
      count={templates.length}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search templates…"
      action={
        <Button variant="success" icon="heroicons-outline:plus" onClick={() => { setMode("create"); setSelectedId(null); }} className="!px-2.5 !py-1 text-xs">New</Button>
      }
    >
      {q.isLoading ? (
        <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted">{search.trim() ? "No templates match your search." : "No templates yet."}</div>
      ) : (
        <ul className="divide-y divide-card-border">
          {filtered.map((t) => {
            const isSel = t.template_id === selectedId && mode !== "create";
            return (
              <li key={t.template_id} className="relative">
                <button
                  onClick={() => { setSelectedId(t.template_id); setMode("view"); }}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${isSel ? "bg-hover" : "hover:bg-hover"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-purple-500" />}
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-purple-500/10 text-purple-500 shrink-0">
                    <Icon icon="heroicons-outline:bell-alert" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground truncate">{t.name}</span>
                      <span className="text-[9px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted uppercase shrink-0">{titleize(t.channel_type)}</span>
                    </span>
                    <span className="block text-[11px] text-muted truncate mt-0.5">{t.subject || t.body?.slice(0, 80)}</span>
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
            <TemplateForm
              key={mode === "edit" ? selected?.template_id : "new"}
              template={mode === "edit" ? selected : null}
              onCancel={() => setMode("view")}
              onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-templates"] }); setMode("view"); }}
            />
          </div>
        ) : !selected ? (
          <EmptyDetail icon="heroicons-outline:bell-alert" title="No template selected" subtitle="Pick one from the list or click New." />
        ) : (
          <TemplateDetail template={selected} onEdit={() => setMode("edit")} onDelete={() => askDelete(selected)} />
        )}
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </MasterDetail>
  );
}
