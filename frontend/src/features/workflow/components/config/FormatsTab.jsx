"use client";

// Formats tab — alert-format CRUD. Each format maps an alert_code to
// presentation (severity/priority/colour/icon/sound) and an optional target SOP.
// Mirrors TriggersTab/FormsTab: inline create/edit via FormatForm + delete
// confirmation. A duplicate alert_code returns 409 from the backend — surfaced
// as a friendly toast.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner, Badge } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, idOf, titleize } from "@/lib/format";
import { PRIORITY_COLOR } from "../../constants";
import { workflow as wfApi } from "../../api";
import FormatForm from "./FormatForm";

// severity shares the priority colour scale (low→slate … critical→red).
const SEVERITY_COLOR = PRIORITY_COLOR;

export default function FormatsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-alert-formats"], queryFn: () => wfApi.alertFormats.list({ limit: 200 }) });
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const formats = asItems(q.data);
  const sops = asItems(sopsQ.data);
  const [form, setForm] = useState(null); // {} for new, format obj for edit
  const [confirm, setConfirm] = useState(null);

  const sopName = (sid) => sops.find((s) => idOf(s, "id", "sop_id") === sid)?.name || null;

  // 409 (duplicate alert_code) → friendly message; everything else via apiError.
  function onSaveError(e) {
    if (e?.response?.status === 409) {
      toast.error("That alert code is already in use — pick a unique code.");
    } else {
      toast.error(apiError(e));
    }
  }

  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? wfApi.alertFormats.update(id, body) : wfApi.alertFormats.create(body)),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["wf-alert-formats"] }); setForm(null); },
    onError: onSaveError,
  });
  const remove = useMutation({
    mutationFn: (id) => wfApi.alertFormats.remove(id),
    onSuccess: () => { toast.success("Format removed"); qc.invalidateQueries({ queryKey: ["wf-alert-formats"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Alert formats</h3>
          <p className="text-xs text-muted">Map an alert code to how it looks (severity/colour/sound) and an optional target SOP.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">Add format</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <FormatForm
            format={idOf(form, "format_id", "id") ? form : null}
            sops={sops}
            pending={save.isPending}
            onCancel={() => setForm(null)}
            onSubmit={(body) => save.mutate({ id: idOf(form, "format_id", "id"), body })}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : formats.length === 0 && !form ? (
          <p className="text-sm text-muted">No alert formats yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {formats.map((f) => {
              const sn = sopName(f.sop_id);
              return (
                <li key={idOf(f, "format_id", "id")} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white shrink-0"
                    style={{ background: f.color_code || "#ef4444" }}
                  >
                    <Icon icon={f.icon || "heroicons-outline:swatch"} className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{f.name}</span>
                      <Badge color={SEVERITY_COLOR[f.severity] || "slate"}>{titleize(f.severity)}</Badge>
                      <Badge color={PRIORITY_COLOR[f.priority] || "slate"}>{titleize(f.priority)}</Badge>
                      <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${f.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{f.is_active === false ? "Inactive" : "Active"}</span>
                    </span>
                    <span className="block text-[11px] text-muted font-mono truncate">
                      {f.alert_code}
                      {f.category ? ` · ${f.category}` : ""}
                      {sn ? ` → ${sn}${f.sop_mode ? ` (${f.sop_mode})` : ""}` : ""}
                    </span>
                  </span>
                  <button onClick={() => setForm(f)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                  <button onClick={() => setConfirm({ title: "Delete format?", message: `Delete "${f.name}" (${f.alert_code})?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(idOf(f, "format_id", "id")); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
