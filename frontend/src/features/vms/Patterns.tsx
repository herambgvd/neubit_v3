"use client";

// VMS → Config → Patterns. A minimal-chrome console like every other Configurations
// surface: ConsolePage frame + MasterDetail, with the Patterns | Camera Groups
// segment in the GLOBAL top bar (ConsoleStrip) rather than a tab bar of its own —
// which is what made this page read as a different product from Video Wall next door.
//   • Patterns    = named rotating sequences of camera GROUPS (dwell seconds).
//   • Camera Groups = a set of cameras arranged in a grid layout (the unit a
//     pattern rotates through).
// The detail's "Open in streaming" launches the wall in pattern-rotation mode.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/kit";
import { ConsolePage } from "@/components/console";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import { useEstateCameras } from "./hooks/useEstateCameras";
import PatternListRow from "./components/PatternListRow";
import PatternDetail from "./components/PatternDetail";
import PatternFormModal from "./components/PatternFormModal";
import CameraGroupFormModal from "./components/CameraGroupFormModal";

export default function Patterns() {
  const qc = useQueryClient();
  // Patterns | Camera Groups lives in the global top bar (ConsoleStrip) now, not in
  // a tab bar of this page's own — so the active one is read from ?view=, the same
  // way Platform, Workflow and Building Intelligence read theirs. "patterns" is the
  // default and owns the bare URL.
  const view = useSearchParams().get("view");
  const tab = view === "groups" ? "groups" : "patterns";
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<any>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [confirm, setConfirm] = useState<any>(null);

  const isPatternTab = tab === "patterns";

  // ── data ──────────────────────────────────────────────────────────────────
  const patternsQ = useQuery<any>({
    queryKey: ["vms-patterns"],
    queryFn: () => vms.patterns.list(),
    refetchInterval: 30_000,
  });
  const groupsQ = useQuery<any>({
    queryKey: ["vms-camera-groups"],
    queryFn: () => vms.groups.list(),
    refetchInterval: 30_000,
  });

  const patterns = useMemo(() => asItems(patternsQ.data), [patternsQ.data]);
  const groups = useMemo(() => asItems(groupsQ.data), [groupsQ.data]);
  // Local + FEDERATED cameras, exactly as the wall sees them. This page used to
  // read `/vms/cameras` alone; on a federated install that list is empty, so the
  // builder had nothing to place and a saved group's detail printed the stored
  // `fed:<node>:<cam>` id instead of the camera's name.
  const { cameras, cameraById } = useEstateCameras();

  const groupById = useMemo(() => {
    const m = new Map<any, any>();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);

  const items = isPatternTab ? patterns : groups;
  const listLoading = isPatternTab ? patternsQ.isLoading : groupsQ.isLoading;
  const listError = isPatternTab ? patternsQ.error : groupsQ.error;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      (i) => i.name?.toLowerCase().includes(term) || i.description?.toLowerCase?.().includes(term),
    );
  }, [items, search]);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) || null, [items, selectedId]);

  // Auto-select the first row when nothing is selected on the current tab.
  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  // Selection needs no reset — the other tab's id is simply not in `items`, so
  // `selected` goes null and the auto-select above picks that tab's first row. The
  // search term does need clearing: "lobby" typed against patterns is not a filter
  // anyone asked to carry over to groups.
  useEffect(() => setSearch(""), [tab]);

  // ── mutations (toggle active / delete) ─────────────────────────────────────
  const invalidateActive = () =>
    qc.invalidateQueries({ queryKey: [isPatternTab ? "vms-patterns" : "vms-camera-groups"] });

  const toggleActive = useMutation<any, any, any>({
    mutationFn: ({ id, is_active }: any) =>
      isPatternTab ? vms.patterns.update(id, { is_active }) : vms.groups.update(id, { is_active }),
    onSuccess: () => invalidateActive(),
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const remove = useMutation<any>({
    mutationFn: (id: any) => (isPatternTab ? vms.patterns.remove(id) : vms.groups.remove(id)),
    onSuccess: (_d, id) => {
      toast.success(`${isPatternTab ? "Pattern" : "Camera group"} deleted`);
      if (selectedId === id) setSelectedId(null);
      invalidateActive();
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const askDelete = (item) =>
    setConfirm({
      title: `Delete ${isPatternTab ? "pattern" : "camera group"}`,
      message: `This will remove “${item.name}”. This action cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => {
        remove.mutate(item.id);
        setConfirm(null);
      },
    });

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };
  const openEdit = (item) => {
    setEditTarget(item);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditTarget(null);
  };

  const activeCount = items.filter((i) => i.is_active !== false).length;

  return (
    <ConsolePage>
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title={isPatternTab ? "Patterns" : "Camera Groups"}
            count={items.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder={isPatternTab ? "Search patterns…" : "Search groups…"}
            action={
              <div className="flex items-center gap-1">
                <button
                  onClick={invalidateActive}
                  title="Refresh"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
                >
                  <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
                </button>
                <button
                  onClick={openCreate}
                  title={isPatternTab ? "New pattern" : "New camera group"}
                  className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)]"
                >
                  <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
                <span className="text-nb-muted">{activeCount} active</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-nb-faint" />
                <span className="text-nb-muted">{items.length - activeCount} inactive</span>
              </span>
            </div>

            {listLoading ? (
              <div className="px-4 py-6 text-center text-xs text-nb-muted">
                <Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base" />
                Loading…
              </div>
            ) : listError ? (
              <div className="px-4 py-6 text-center text-xs text-nb-crit">{apiError(listError, "Failed to load")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(96,165,250,.1)]">
                  <Icon
                    icon={isPatternTab ? "heroicons:squares-2x2" : "heroicons-outline:video-camera"}
                    className="text-lg text-nb-muted"
                  />
                </div>
                <div className="text-sm font-medium text-nb-ink">
                  {search.trim()
                    ? "No matches"
                    : isPatternTab
                      ? "No patterns yet"
                      : "No camera groups yet"}
                </div>
                <div className="mt-0.5 text-xs text-nb-muted">
                  {search.trim()
                    ? "Try a different keyword."
                    : isPatternTab
                      ? "Click Add to create your first pattern."
                      : "Click Add to create your first camera group."}
                </div>
              </div>
            ) : (
              <div className="space-y-0.5 px-2 py-2">
                {filtered.map((i) => (
                  <PatternListRow
                    key={i.id}
                    item={i}
                    isPattern={isPatternTab}
                    isSelected={selectedId === i.id}
                    onSelect={(d) => setSelectedId(d.id)}
                    onToggleActive={(d) => toggleActive.mutate({ id: d.id, is_active: d.is_active === false })}
                    onEdit={openEdit}
                    onDelete={askDelete}
                  />
                ))}
              </div>
            )}
          </ListPanel>
        }
      >
        {selected ? (
          <PatternDetail
            key={selected.id}
            item={selected}
            isPattern={isPatternTab}
            groupById={groupById}
            cameraById={cameraById}
            onEdit={openEdit}
            onDelete={askDelete}
            onToggleActive={(d) => toggleActive.mutate({ id: d.id, is_active: d.is_active === false })}
          />
        ) : (
          <EmptyDetail
            icon={isPatternTab ? "heroicons:squares-2x2" : "heroicons-outline:video-camera"}
            title={isPatternTab ? "Select a pattern" : "Select a camera group"}
            subtitle="Choose one from the list, or create a new one."
          />
        )}
      </MasterDetail>

      {/* Editor modals — pattern vs camera-group builder */}
      {isPatternTab ? (
        <PatternFormModal
          open={formOpen}
          pattern={editTarget}
          groups={groups}
          onClose={closeForm}
          onSaved={(saved) => saved?.id && setSelectedId(saved.id)}
        />
      ) : (
        <CameraGroupFormModal
          open={formOpen}
          group={editTarget}
          cameras={cameras}
          onClose={closeForm}
          onSaved={(saved) => saved?.id && setSelectedId(saved.id)}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </ConsolePage>
  );
}
