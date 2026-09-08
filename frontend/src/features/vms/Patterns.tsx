"use client";

// VMS → Config → Patterns. Two lists behind one segment in the GLOBAL top bar:
//   • Patterns = named rotating sequences of GROUPS (dwell seconds).
//   • Groups   = a set of cameras arranged in a grid layout — the unit a pattern
//     rotates through, and what the wall paints when one is applied.
//
// "Camera Groups" was the old name. Everything in this console is cameras; the
// word bought nothing and made the segment the widest thing in the top bar.
//
// It is built from the shared console primitives (ConsoleGrid / ConsolePanel /
// PanelHeader / PanelList) rather than its own MasterDetail + ListPanel pair, so
// the rail width, the header plus, the counts and the three list states are the
// same here as on Sites, Tags and Federation — this page used to be the odd one
// with a labelled "Add" button and a hand-rolled empty state.
// The detail's "Open in streaming" launches the wall in pattern-rotation mode.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ConfirmDialog, type ConfirmState } from "@/components/ui/kit";
import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  IconButton,
  PanelCounts,
  PanelHeader,
  PanelList,
  PanelSearch,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import type { CameraGroupPublic, PatternPublic } from "./types";
import { useEstateCameras } from "./hooks/useEstateCameras";
import { isPatternItem, type PatternItem } from "./components/patternTypes";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PatternItem | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const isPatternTab = tab === "patterns";

  // ── data ──────────────────────────────────────────────────────────────────
  const patternsQ = useQuery({
    queryKey: ["vms-patterns"],
    queryFn: () => vms.patterns.list(),
    refetchInterval: 30_000,
  });
  const groupsQ = useQuery({
    queryKey: ["vms-camera-groups"],
    queryFn: () => vms.groups.list(),
    refetchInterval: 30_000,
  });

  const patterns = useMemo<PatternPublic[]>(() => (patternsQ.data ? asItems(patternsQ.data) : []), [patternsQ.data]);
  const groups = useMemo<CameraGroupPublic[]>(() => (groupsQ.data ? asItems(groupsQ.data) : []), [groupsQ.data]);
  // Local + FEDERATED cameras, exactly as the wall sees them. This page used to
  // read `/vms/cameras` alone; on a federated install that list is empty, so the
  // builder had nothing to place and a saved group's detail printed the stored
  // `fed:<node>:<cam>` id instead of the camera's name.
  const { cameras, cameraById } = useEstateCameras();

  const groupById = useMemo(() => {
    const m = new Map<string, CameraGroupPublic>();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);

  const items: PatternItem[] = isPatternTab ? patterns : groups;
  const listLoading = isPatternTab ? patternsQ.isLoading : groupsQ.isLoading;
  const listError = isPatternTab ? patternsQ.error : groupsQ.error;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      (i) => i.name?.toLowerCase().includes(term) || i.description?.toLowerCase?.().includes(term),
    );
  }, [items, search]);

  // The explicit choice, or the first row when there is none. Derived here
  // rather than synced by an effect, which rendered one frame with nothing
  // selected before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;

  const selected = useMemo(() => items.find((i) => i.id === effectiveId) || null, [items, effectiveId]);

  // Auto-select the first row when nothing is selected on the current tab.

  // Selection needs no reset — the other tab's id is simply not in `items`, so
  // `selected` goes null and the auto-select above picks that tab's first row. The
  // search term does need clearing: "lobby" typed against patterns is not a filter
  // anyone asked to carry over to groups.
  useEffect(() => setSearch(""), [tab]);

  // ── mutations (toggle active / delete) ─────────────────────────────────────
  const invalidateActive = () =>
    qc.invalidateQueries({ queryKey: [isPatternTab ? "vms-patterns" : "vms-camera-groups"] });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }): Promise<PatternItem> =>
      isPatternTab ? vms.patterns.update(id, { is_active }) : vms.groups.update(id, { is_active }),
    onSuccess: () => invalidateActive(),
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => (isPatternTab ? vms.patterns.remove(id) : vms.groups.remove(id)),
    onSuccess: (_d, id) => {
      toast.success(`${isPatternTab ? "Pattern" : "Group"} deleted`);
      if (effectiveId === id) setSelectedId(null);
      invalidateActive();
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const askDelete = (item: PatternItem) =>
    setConfirm({
      title: `Delete ${isPatternTab ? "pattern" : "group"}`,
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
  const openEdit = (item: PatternItem) => {
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
      <ConsoleGrid>
        {/* LEFT — the list for whichever tab is showing */}
        <ConsolePanel>
          <PanelHeader
            icon={isPatternTab ? "heroicons-outline:squares-2x2" : "heroicons-outline:video-camera"}
            title={isPatternTab ? "Patterns" : "Groups"}
            count={items.length}
            actions={
              <>
                <PanelCounts
                  items={[
                    { tone: "good", value: activeCount, label: "active" },
                    { tone: "idle", value: items.length - activeCount, label: "inactive" },
                  ]}
                />
                <IconButton
                  icon="heroicons:plus"
                  title={isPatternTab ? "New pattern" : "New group"}
                  onClick={openCreate}
                />
              </>
            }
          />
          <PanelSearch
            value={search}
            onChange={setSearch}
            placeholder={isPatternTab ? "Search patterns…" : "Search groups…"}
          />
          <PanelList
            loading={listLoading}
            // A failed load must never read as "none created yet".
            error={listError ? apiError(listError, "Failed to load") : undefined}
            empty={filtered.length === 0}
            emptyText={
              search.trim()
                ? "No matches — try a different keyword."
                : isPatternTab
                  ? "No patterns yet. Use ＋ above to create one."
                  : "No groups yet. Use ＋ above to create one."
            }
          >
            {filtered.map((i) => (
              <PatternListRow
                key={i.id}
                item={i}
                isPattern={isPatternTab}
                isSelected={effectiveId === i.id}
                onSelect={(d) => setSelectedId(d.id)}
                onToggleActive={(d) => toggleActive.mutate({ id: d.id, is_active: d.is_active === false })}
                onEdit={openEdit}
                onDelete={askDelete}
              />
            ))}
          </PanelList>
        </ConsolePanel>

        {/* RIGHT — the selected pattern or group */}
        <ConsolePanel>
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
          <EmptyPane
            icon={isPatternTab ? "heroicons-outline:squares-2x2" : "heroicons-outline:video-camera"}
            title={isPatternTab ? "No pattern selected" : "No group selected"}
            subtitle="Pick one from the list, or use ＋ above to create one."
          />
        )}
        </ConsolePanel>
      </ConsoleGrid>

      {/* Editor modals — pattern vs camera-group builder */}
      {isPatternTab ? (
        <PatternFormModal
          open={formOpen}
          pattern={editTarget && isPatternItem(editTarget) ? editTarget : null}
          groups={groups}
          onClose={closeForm}
          onSaved={(saved) => saved?.id && setSelectedId(saved.id)}
        />
      ) : (
        <CameraGroupFormModal
          open={formOpen}
          group={editTarget && !isPatternItem(editTarget) ? editTarget : null}
          cameras={cameras}
          onClose={closeForm}
          onSaved={(saved) => saved?.id && setSelectedId(saved.id)}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </ConsolePage>
  );
}
