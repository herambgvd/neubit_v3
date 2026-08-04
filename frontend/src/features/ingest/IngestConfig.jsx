"use client";

// Ingest configuration — navy-console master/detail. LEFT a category card rail
// (search + dashed New Category), RIGHT the selected category's webhooks. This is
// the thin orchestrator: it owns selection/mode/confirm state and the category
// list query, and wires the decomposed components (CategoryList, CategoryDetail,
// CategoryFormModal).
//
//   • The public receiver `/ingest/hooks/{token}` is server-only — displayed
//     read-only with a copy button; never called from the UI.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { ConfirmDialog } from "@/components/ui/kit";
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

  const col = "rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] min-h-0 flex flex-col overflow-hidden";

  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[300px_1fr]">
        {/* LEFT — category rail */}
        <CategoryList
          className={col}
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
          onNew={() => setMode("create")}
        />

        {/* CENTER — detail */}
        <div className={col}>
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
                <Icon icon="heroicons-outline:arrow-down-on-square-stack" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-nb-ink">No category selected</div>
              <div className="mt-0.5 text-xs text-nb-faint">
                Pick one from the list, or click <b className="text-nb-blueb">＋ New category</b>.
              </div>
            </div>
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
        </div>
      </div>

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
