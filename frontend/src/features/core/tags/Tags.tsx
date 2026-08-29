"use client";

// Tags configuration — cross-cutting, color-coded labels usable across modules
// (sites/zones today, devices/incidents later). Two-pane master/detail: a search
// list on the left, a create/edit form or read-only detail on the right. Thin
// orchestrator — owns selection/mode/confirm state + the list query and wires the
// decomposed TagList / TagDetail / TagForm components.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelCounts,
  PanelSearch,
  PanelFooter,
  CreateButton,
  EmptyPane,
} from "@/components/console";
import { ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { tags as tagsApi } from "@/lib/api/tags";
import TagList from "./components/TagList";
import TagDetail from "./components/TagDetail";
import TagForm from "./components/TagForm";

export default function TagsConfigPage() {
  const qc = useQueryClient();
  const tagsQ = useQuery<any>({
    queryKey: ["tags-list"],
    queryFn: () => tagsApi.list({ limit: 200 }),
  });

  const items = tagsQ.data?.items || [];
  const total = tagsQ.data?.total ?? items.length;
  const active = items.filter((t) => t.is_active !== false).length;
  const inactive = items.length - active;

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<any>(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState<any>(null);

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return items;
    return items.filter((t) =>
      [t.name, t.description].filter(Boolean).join(" ").toLowerCase().includes(f),
    );
  }, [items, q]);

  const selected = useMemo(
    () => items.find((t) => t.tag_id === selectedId) || null,
    [items, selectedId],
  );

  // Open on the first tag by default (and after a delete/search change), matching
  // the other config modules. Skipped while creating/editing so the form stays put.
  useEffect(() => {
    if (mode === "view" && !selected && filtered[0]) {
      setSelectedId(filtered[0].tag_id);
    }
  }, [filtered, selected, mode]);

  const remove = useMutation<any>({
    mutationFn: (id: any) => tagsApi.remove(id),
    onSuccess: () => {
      toast.success("Tag removed");
      qc.invalidateQueries({ queryKey: ["tags-list"] });
      setSelectedId(null);
      setMode("view");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const editing = mode === "edit" ? selected : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]">
        {/* LEFT — library */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:tag"
            title="Tags"
            count={total}
            actions={
              <PanelCounts
                items={[
                  { tone: "good", value: active, label: "active" },
                  { tone: "idle", value: inactive, label: "inactive" },
                ]}
              />
            }
          />
          <PanelSearch value={q} onChange={setQ} placeholder="Search tags…" />

          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            <TagList
              items={filtered}
              loading={tagsQ.isLoading}
              query={q}
              selectedId={selectedId}
              mode={mode}
              onSelect={(id) => {
                setSelectedId(id);
                setMode("view");
              }}
            />
          </div>

          <PanelFooter>
            <CreateButton
              label="TAG"
              onClick={() => {
                setSelectedId(null);
                setMode("create");
              }}
            />
          </PanelFooter>
        </ConsolePanel>

        {/* CENTER — detail */}
        <ConsolePanel>
          {mode === "create" || editing ? (
            <TagForm
              key={editing ? editing.tag_id : "create"}
              tag={editing}
              onCancel={() => setMode("view")}
              onSaved={(saved) => {
                qc.invalidateQueries({ queryKey: ["tags-list"] });
                if (saved?.tag_id) setSelectedId(saved.tag_id);
                setMode("view");
              }}
            />
          ) : !selected ? (
            <EmptyPane
              icon="heroicons-outline:tag"
              title="No tag selected"
              subtitle="Pick one from the list, or click ＋ NEW TAG to create a tag."
            />
          ) : (
            <TagDetail
              tag={selected}
              onEdit={() => setMode("edit")}
              onDelete={() =>
                setConfirm({
                  title: "Delete tag?",
                  message: `Delete tag "${selected.name}"? It will be detached from every entity it is applied to.`,
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    remove.mutate(selected.tag_id);
                    setConfirm(null);
                  },
                })
              }
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
