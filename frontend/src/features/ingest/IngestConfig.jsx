"use client";

// Ingest configuration — two-pane master/detail. LEFT a category list (search +
// CRUD), RIGHT the selected category's webhooks. This is the thin orchestrator:
// it owns selection/mode/confirm state and the category list query, and wires the
// decomposed components (CategoryList, CategoryDetail, CategoryFormModal).
//
//   • CSS-var theme → semantic tokens (foreground/muted/card/hover…).
//   • The public receiver `/ingest/hooks/{token}` is server-only — displayed
//     read-only with a copy button; never called from the UI.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader } from "@/components/ui/kit";
import { MasterDetail, EmptyDetail } from "@/components/common";
import { asItems, idOf } from "@/lib/format";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "./api";
import CategoryList from "./components/CategoryList";
import CategoryDetail from "./components/CategoryDetail";
import CategoryFormModal from "./components/CategoryFormModal";

export default function IngestConfigPage() {
  const qc = useQueryClient();
  const catsQ = useQuery({
    queryKey: ["ingest-categories"],
    queryFn: () => ingestApi.categories.list({ limit: 100 }),
  });

  const cats = useMemo(() => asItems(catsQ.data), [catsQ.data]);

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit (category)
  const [closed, setClosed] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const catId = (c) => idOf(c, "id", "category_id");

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return cats;
    return cats.filter((c) =>
      [c.name, c.description].filter(Boolean).join(" ").toLowerCase().includes(f),
    );
  }, [cats, q]);

  const selected = useMemo(
    () => cats.find((c) => catId(c) === selectedId) || null,
    [cats, selectedId],
  );

  useEffect(() => {
    if (mode === "view" && !closed && !selected && filtered[0]) {
      setSelectedId(catId(filtered[0]));
    }
  }, [filtered, selected, mode, closed]);

  const removeCat = useMutation({
    mutationFn: (id) => ingestApi.categories.remove(id),
    onSuccess: () => {
      toast.success("Category removed");
      qc.invalidateQueries({ queryKey: ["ingest-categories"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div>
      <PageHeader
        title="Ingest"
        subtitle="Receive events from external systems via categorized webhooks."
        actions={
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setMode("create")}>
            Add category
          </Button>
        }
      />

      <MasterDetail
        aside={
          <CategoryList
            categories={filtered}
            total={cats.length}
            loading={catsQ.isLoading}
            search={q}
            onSearch={setQ}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setMode("view");
              setClosed(false);
            }}
            catId={catId}
            suppressSelected={mode === "create"}
          />
        }
      >
        {!selected ? (
          <EmptyDetail
            icon="heroicons-outline:arrow-down-on-square-stack"
            title="No category selected"
            subtitle="Pick one from the list, or click Add category."
          />
        ) : (
          <CategoryDetail
            category={selected}
            catId={catId(selected)}
            onEdit={() => setMode("edit")}
            onDelete={() =>
              setConfirm({
                title: "Delete category?",
                message: `Delete "${selected.name}" and all of its webhooks? This cannot be undone.`,
                confirmLabel: "Delete",
                onConfirm: () => {
                  removeCat.mutate(catId(selected));
                  setConfirm(null);
                },
              })
            }
          />
        )}
      </MasterDetail>

      {(mode === "create" || mode === "edit") && (
        <CategoryFormModal
          key={mode === "edit" ? selectedId : "create"}
          category={mode === "edit" ? selected : null}
          onCancel={() => setMode("view")}
          onSaved={(saved) => {
            qc.invalidateQueries({ queryKey: ["ingest-categories"] });
            const id = idOf(saved, "id", "category_id");
            if (id) setSelectedId(id);
            setMode("view");
          }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={removeCat.isPending} />
    </div>
  );
}
