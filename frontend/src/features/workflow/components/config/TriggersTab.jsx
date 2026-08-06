"use client";

// Triggers tab — master (trigger list) / detail (read-only detail, or the
// create/edit TriggerForm). Matches the v2 master-detail layout: a fixed 360px
// console list panel on the left, the detail/editor/empty pane on the right.
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
import { asItems, idOf, fmtRelative } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import TriggerForm from "./TriggerForm";
import TriggerDetail from "./TriggerDetail";
import TriggerTestModal from "./TriggerTestModal";

const trigId = (t) => idOf(t, "id", "trigger_id");

export default function TriggersTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-triggers"], queryFn: () => wfApi.triggers.list({ limit: 200 }) });
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const triggers = asItems(q.data);
  const sops = asItems(sopsQ.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);
  const [test, setTest] = useState(null);
  const [search, setSearch] = useState("");

  const sopName = (sid) => sops.find((s) => idOf(s, "id", "sop_id") === sid)?.name || "—";

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return triggers;
    return triggers.filter((t) =>
      (t.name || "").toLowerCase().includes(s) ||
      (t.event_type || "").toLowerCase().includes(s) ||
      (t.event_source || "").toLowerCase().includes(s));
  }, [triggers, search]);

  const selected = useMemo(() => (mode === "create" ? null : triggers.find((t) => trigId(t) === selectedId) || null), [triggers, selectedId, mode]);

  useEffect(() => {
    if (mode === "view" && !selected && filtered[0]) setSelectedId(trigId(filtered[0]));
  }, [filtered, selected, mode]);

  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? wfApi.triggers.update(id, body) : wfApi.triggers.create(body)),
    onSuccess: (saved) => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); const id = trigId(saved); if (id) setSelectedId(id); setMode("view"); },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: (id) => wfApi.triggers.remove(id),
    onSuccess: () => { toast.success("Trigger removed"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); setSelectedId(null); },
    onError: (e) => toast.error(apiError(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => (enabled ? wfApi.triggers.disable(id) : wfApi.triggers.enable(id)),
    onSuccess: (_d, v) => { toast.success(v.enabled ? "Disabled" : "Enabled"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  function askDelete(t) {
    setConfirm({ title: "Delete trigger?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(trigId(t)); setConfirm(null); } });
  }

  const aside = (
    <ConsolePanel>
      <PanelHeader icon="heroicons:bolt" title="Triggers" count={triggers.length} />
      <PanelSearch value={search} onChange={setSearch} placeholder="Search triggers…" />
      <PanelList
        loading={q.isLoading}
        empty={filtered.length === 0}
        emptyText={search.trim() ? "No triggers match your search" : "No triggers yet"}
      >
          {filtered.map((t) => {
            const isSel = trigId(t) === selectedId && mode !== "create";
            const enabled = t.enabled !== false;
            return (
              <button key={trigId(t)}
                  onClick={() => { setSelectedId(trigId(t)); setMode("view"); }}
                  className={`relative w-full flex items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition border ${isSel ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]" : "border-transparent hover:bg-[rgba(96,165,250,.06)]"}`}
                >
                  {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-nb-warn" />}
                  <span className={`inline-flex h-8 w-8 items-center justify-center rounded-md shrink-0 ${enabled ? "bg-nb-warn/10 text-nb-warn" : "bg-[rgba(10,18,40,.65)] text-nb-faint"}`}>
                    <Icon icon="heroicons:bolt" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-nb-ink truncate">{t.name}</span>
                      <span className={`shrink-0 text-[9px] rounded-full px-1.5 py-0.5 font-medium uppercase ${enabled ? "bg-nb-good/10 text-nb-good" : "bg-[rgba(10,18,40,.65)] text-nb-faint"}`}>{enabled ? "On" : "Off"}</span>
                    </span>
                    <span className="block text-[11px] text-nb-faint font-mono truncate mt-0.5">
                      {t.event_source ? `${t.event_source}:` : ""}{t.event_type || "any"} → {sopName(t.sop_id)}
                    </span>
                    <span className="block text-[10px] text-nb-faint/70 truncate">fired {t.fire_count ?? 0}× · last {fmtRelative(t.last_fired_at)}</span>
                  </span>
                </button>
            );
          })}
      </PanelList>

      <PanelFooter>
        <CreateButton label="TRIGGER" onClick={() => { setMode("create"); setSelectedId(null); }} />
      </PanelFooter>
    </ConsolePanel>
  );

  return (
    <>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]" className="h-full">
        {aside}
        <ConsolePanel>
        {mode === "create" || mode === "edit" ? (
          <TriggerForm
              key={mode === "edit" ? trigId(selected) : "new"}
              trigger={mode === "edit" ? selected : null}
              sops={sops}
              pending={save.isPending}
              onCancel={() => setMode("view")}
              onSubmit={(body) => save.mutate({ id: mode === "edit" ? trigId(selected) : null, body })}
            />
        ) : !selected ? (
          <EmptyPane icon="heroicons:bolt" title="No trigger selected" subtitle="Pick one from the list, or click ＋ NEW TRIGGER to create one." />
        ) : (
          <TriggerDetail
            trigger={selected}
            sopName={sopName(selected.sop_id)}
            onEdit={() => setMode("edit")}
            onDelete={() => askDelete(selected)}
            onToggle={() => toggle.mutate({ id: trigId(selected), enabled: selected.enabled !== false })}
            toggling={toggle.isPending}
            onTest={() => setTest(selected)}
          />
        )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
      <TriggerTestModal open={!!test} trigger={test} onClose={() => setTest(null)} />

    </>
  );
}
