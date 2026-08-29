"use client";

// Notification templates tab — master (template list) / detail (read-only
// detail, or the create/edit TemplateForm). v2 master-detail layout: 360px
// console list panel on the left, detail/editor/empty on the right.
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
import { asItems, titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import TemplateForm from "./TemplateForm";
import TemplateDetail from "./TemplateDetail";

export default function NotificationTemplatesTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ["wf-templates"], queryFn: () => wfApi.notifications.templates.list({ limit: 200 }) });
  const templates = asItems(q.data);

  const [selectedId, setSelectedId] = useState<any>(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState<any>(null);
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

  const remove = useMutation<any>({
    mutationFn: (id: any) => wfApi.notifications.templates.remove(id),
    onSuccess: () => { toast.success("Template removed"); qc.invalidateQueries({ queryKey: ["wf-templates"] }); setSelectedId(null); },
    onError: (e) => toast.error(apiError(e)),
  });

  function askDelete(t) {
    setConfirm({ title: "Delete template?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(t.template_id); setConfirm(null); } });
  }

  const aside = (
    <ConsolePanel>
      <PanelHeader icon="heroicons-outline:bell-alert" title="Templates" count={templates.length} />
      <PanelSearch value={search} onChange={setSearch} placeholder="Search templates…" />
      <PanelList
        loading={q.isLoading}
        empty={filtered.length === 0}
        emptyText={search.trim() ? "No templates match your search" : "No templates yet"}
      >
          {filtered.map((t) => {
            const isSel = t.template_id === selectedId && mode !== "create";
            return (
              <button key={t.template_id}
                  onClick={() => { setSelectedId(t.template_id); setMode("view"); }}
                  className={`relative w-full flex items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition border ${isSel ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]" : "border-transparent hover:bg-[rgba(96,165,250,.06)]"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-nb-violet" />}
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-nb-violet/10 text-nb-violetb shrink-0">
                    <Icon icon="heroicons-outline:bell-alert" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-nb-ink truncate">{t.name}</span>
                      <span className="text-[9px] rounded-full px-1.5 py-0.5 font-medium bg-[rgba(10,18,40,.65)] text-nb-faint uppercase shrink-0">{titleize(t.channel_type)}</span>
                    </span>
                    <span className="block text-[11px] text-nb-faint truncate mt-0.5">{t.subject || t.body?.slice(0, 80)}</span>
                  </span>
                </button>
            );
          })}
      </PanelList>

      <PanelFooter>
        <CreateButton label="TEMPLATE" onClick={() => { setMode("create"); setSelectedId(null); }} />
      </PanelFooter>
    </ConsolePanel>
  );

  return (
    <>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]" className="h-full">
        {aside}
        <ConsolePanel>
        {mode === "create" || mode === "edit" ? (
          <TemplateForm
              key={mode === "edit" ? selected?.template_id : "new"}
              template={mode === "edit" ? selected : null}
              onCancel={() => setMode("view")}
              onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-templates"] }); setMode("view"); }}
            />
        ) : !selected ? (
          <EmptyPane icon="heroicons-outline:bell-alert" title="No template selected" subtitle="Pick one from the list, or click ＋ NEW TEMPLATE to create one." />
        ) : (
          <TemplateDetail template={selected} onEdit={() => setMode("edit")} onDelete={() => askDelete(selected)} />
        )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />

    </>
  );
}
