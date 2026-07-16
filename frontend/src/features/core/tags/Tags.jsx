"use client";

// Tags configuration — cross-cutting, color-coded labels usable across modules
// (sites/zones today, devices/incidents later). Two-pane master/detail: a search
// list on the left, a create/edit form or read-only detail on the right. Thin
// orchestrator — owns selection/mode/confirm state + the list query and wires the
// decomposed TagList / TagDetail / TagForm components.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Icon } from "@iconify/react";

import { ConfirmDialog } from "@/components/ui/kit";
import { MasterDetail, ListPanel } from "@/components/common";
import { apiError } from "@/lib/api";
import { tags as tagsApi } from "@/lib/api/tags";
import TagList from "./components/TagList";
import TagDetail from "./components/TagDetail";
import TagForm from "./components/TagForm";

export default function TagsConfigPage() {
  const qc = useQueryClient();
  const tagsQ = useQuery({
    queryKey: ["tags-list"],
    queryFn: () => tagsApi.list({ limit: 200 }),
  });

  const items = tagsQ.data?.items || [];
  const total = tagsQ.data?.total ?? items.length;

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);

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

  const remove = useMutation({
    mutationFn: (id) => tagsApi.remove(id),
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
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        aside={
          <ListPanel
            title="Tags"
            count={total}
            search={q}
            onSearch={setQ}
            searchPlaceholder="Search tags…"
            action={
              <button
                onClick={() => {
                  setSelectedId(null);
                  setMode("create");
                }}
                title="Add tag"
                className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
              >
                <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
              </button>
            }
          >
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
          </ListPanel>
        }
      >
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
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
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons:tag" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No tag selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add tag</b> to create a new tag.
              </div>
            </div>
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
        </section>
      </MasterDetail>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
