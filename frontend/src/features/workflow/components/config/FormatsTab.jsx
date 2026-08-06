"use client";

// Formats tab — master (alert-format list) / detail (read-only detail, or the
// create/edit FormatForm). Each format maps an alert_code to presentation
// (severity/priority/colour/icon/sound) and an optional target SOP. A duplicate
// alert_code returns 409 → surfaced as a friendly toast. v2 master-detail layout.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Badge } from "@/components/ui/kit";
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
import { asItems, idOf, titleize } from "@/lib/format";
import { PRIORITY_COLOR } from "../../constants";
import { workflow as wfApi } from "../../api";
import FormatForm from "./FormatForm";
import FormatDetail from "./FormatDetail";

const fmtId = (f) => idOf(f, "format_id", "id");

export default function FormatsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-alert-formats"], queryFn: () => wfApi.alertFormats.list({ limit: 200 }) });
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const formats = asItems(q.data);
  const sops = asItems(sopsQ.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");

  const sopName = (sid) => sops.find((s) => idOf(s, "id", "sop_id") === sid)?.name || null;

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return formats;
    return formats.filter((f) =>
      (f.name || "").toLowerCase().includes(s) ||
      (f.alert_code || "").toLowerCase().includes(s) ||
      (f.category || "").toLowerCase().includes(s));
  }, [formats, search]);

  const selected = useMemo(() => (mode === "create" ? null : formats.find((f) => fmtId(f) === selectedId) || null), [formats, selectedId, mode]);

  useEffect(() => {
    if (mode === "view" && !selected && filtered[0]) setSelectedId(fmtId(filtered[0]));
  }, [filtered, selected, mode]);

  function onSaveError(e) {
    if (e?.response?.status === 409) toast.error("That alert code is already in use — pick a unique code.");
    else toast.error(apiError(e));
  }

  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? wfApi.alertFormats.update(id, body) : wfApi.alertFormats.create(body)),
    onSuccess: (saved) => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["wf-alert-formats"] }); const id = fmtId(saved); if (id) setSelectedId(id); setMode("view"); },
    onError: onSaveError,
  });
  const remove = useMutation({
    mutationFn: (id) => wfApi.alertFormats.remove(id),
    onSuccess: () => { toast.success("Format removed"); qc.invalidateQueries({ queryKey: ["wf-alert-formats"] }); setSelectedId(null); },
    onError: (e) => toast.error(apiError(e)),
  });

  function askDelete(f) {
    setConfirm({ title: "Delete format?", message: `Delete "${f.name}" (${f.alert_code})?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(fmtId(f)); setConfirm(null); } });
  }

  const aside = (
    <ConsolePanel>
      <PanelHeader icon="heroicons-outline:swatch" title="Alert formats" count={formats.length} />
      <PanelSearch value={search} onChange={setSearch} placeholder="Search formats…" />
      <PanelList
        loading={q.isLoading}
        empty={filtered.length === 0}
        emptyText={search.trim() ? "No formats match your search" : "No alert formats yet"}
      >
          {filtered.map((f) => {
            const isSel = fmtId(f) === selectedId && mode !== "create";
            const sn = sopName(f.sop_id);
            return (
              <button key={fmtId(f)}
                  onClick={() => { setSelectedId(fmtId(f)); setMode("view"); }}
                  className={`relative w-full flex items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition border ${isSel ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]" : "border-transparent hover:bg-[rgba(96,165,250,.06)]"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: f.color_code || "#ef4444" }} />}
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white shrink-0" style={{ background: f.color_code || "#ef4444" }}>
                    <Icon icon={f.icon || "heroicons-outline:swatch"} className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-nb-ink truncate">{f.name}</span>
                      <Badge color={PRIORITY_COLOR[f.severity] || "slate"}>{titleize(f.severity)}</Badge>
                    </span>
                    <span className="block text-[11px] text-nb-faint font-mono truncate mt-0.5">
                      {f.alert_code}{sn ? ` → ${sn}` : ""}
                    </span>
                  </span>
                </button>
            );
          })}
      </PanelList>

      <PanelFooter>
        <CreateButton label="FORMAT" onClick={() => { setMode("create"); setSelectedId(null); }} />
      </PanelFooter>
    </ConsolePanel>
  );

  return (
    <>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]" className="h-full">
        {aside}
        <ConsolePanel>
        {mode === "create" || mode === "edit" ? (
          <FormatForm
              key={mode === "edit" ? fmtId(selected) : "new"}
              format={mode === "edit" ? selected : null}
              sops={sops}
              pending={save.isPending}
              onCancel={() => setMode("view")}
              onSubmit={(body) => save.mutate({ id: mode === "edit" ? fmtId(selected) : null, body })}
            />
        ) : !selected ? (
          <EmptyPane icon="heroicons-outline:swatch" title="No format selected" subtitle="Pick one from the list, or click ＋ NEW FORMAT to create one." />
        ) : (
          <FormatDetail
            format={selected}
            sopName={sopName(selected.sop_id)}
            onEdit={() => setMode("edit")}
            onDelete={() => askDelete(selected)}
          />
        )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />

    </>
  );
}
