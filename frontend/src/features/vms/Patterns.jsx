"use client";

// VMS → Config → Patterns. Master/detail with a Patterns | Camera Groups toggle
// (ported from neubit_v2's patterns page, rethemed to v3 tokens + the shared
// MasterDetail / ListPanel scaffold).
//   • Patterns    = named rotating sequences of camera GROUPS (dwell seconds).
//   • Camera Groups = a set of cameras arranged in a grid layout (the unit a
//     pattern rotates through).
// The detail's "Open in streaming" launches the wall in pattern-rotation mode.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail, TabBar } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import PatternListRow from "./components/PatternListRow";
import PatternDetail from "./components/PatternDetail";
import PatternFormModal from "./components/PatternFormModal";
import CameraGroupFormModal from "./components/CameraGroupFormModal";

const TABS = [
  { key: "patterns", label: "Patterns", icon: "heroicons:squares-2x2" },
  { key: "groups", label: "Camera Groups", icon: "heroicons-outline:video-camera" },
];

export default function Patterns() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("patterns");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);

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
  const camerasQ = useQuery({
    queryKey: ["vms-patterns-cameras"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 30_000,
  });

  const patterns = useMemo(() => asItems(patternsQ.data), [patternsQ.data]);
  const groups = useMemo(() => asItems(groupsQ.data), [groupsQ.data]);
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  const groupById = useMemo(() => {
    const m = new Map();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);
  const cameraById = useMemo(() => {
    const m = new Map();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

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

  // Reset selection + search when switching tabs.
  function switchTab(next) {
    if (next === tab) return;
    setTab(next);
    setSelectedId(null);
    setSearch("");
  }

  // ── mutations (toggle active / delete) ─────────────────────────────────────
  const invalidateActive = () =>
    qc.invalidateQueries({ queryKey: [isPatternTab ? "vms-patterns" : "vms-camera-groups"] });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }) =>
      isPatternTab ? vms.patterns.update(id, { is_active }) : vms.groups.update(id, { is_active }),
    onSuccess: () => invalidateActive(),
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const remove = useMutation({
    mutationFn: (id) => (isPatternTab ? vms.patterns.remove(id) : vms.groups.remove(id)),
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
    <div>
      <PageHeader
        title="Patterns"
        subtitle="Define camera-group layouts and rotating patterns to play on the streaming video wall."
        actions={
          <Button variant="success" icon="heroicons-outline:plus" onClick={openCreate}>
            {isPatternTab ? "New pattern" : "New camera group"}
          </Button>
        }
      />

      <div className="mb-4">
        <TabBar tabs={TABS} active={tab} onChange={switchTab} />
      </div>

      <MasterDetail
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title={isPatternTab ? "Patterns" : "Camera Groups"}
            count={items.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder={isPatternTab ? "Search patterns…" : "Search groups…"}
            action={
              <button
                onClick={invalidateActive}
                title="Refresh"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-muted">{activeCount} active</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                <span className="text-muted">{items.length - activeCount} inactive</span>
              </span>
            </div>

            {listLoading ? (
              <div className="px-4 py-6 text-center text-xs text-muted">
                <Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base" />
                Loading…
              </div>
            ) : listError ? (
              <div className="px-4 py-6 text-center text-xs text-red-500">{apiError(listError, "Failed to load")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted">
                {items.length === 0
                  ? isPatternTab
                    ? "No patterns yet — click New pattern to create one."
                    : "No camera groups yet — click New camera group to create one."
                  : "No matches."}
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
    </div>
  );
}
