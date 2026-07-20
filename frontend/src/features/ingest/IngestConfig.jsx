"use client";

// Ingest configuration — two-pane master/detail. LEFT a category list (search +
// CRUD), RIGHT the selected category's webhooks. This is the thin orchestrator:
// it owns selection/mode/confirm state and the category list query, and wires the
// decomposed components (CategoryList, CategoryDetail, CategoryFormModal).
//
//   • CSS-var theme → semantic tokens (foreground/muted/card/hover…).
//   • The public receiver `/ingest/hooks/{slug}` is server-only — displayed
//     read-only with a copy button; never called from the UI.
//   • `canManage` (ingest.manage) is resolved once here and threaded down to
//     every pane. The backend gates each mutating route on it regardless; this
//     just stops the UI offering buttons that would 403.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Icon } from "@iconify/react";

import { ConfirmDialog, EmptyState } from "@/components/ui/kit";
import { MasterDetail, EmptyDetail } from "@/components/common";
import { asItems, idOf } from "@/lib/format";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ingest as ingestApi } from "./api";
import { PERM_MANAGE, PERM_READ } from "./constants";
import CategoryList from "./components/CategoryList";
import CategoryDetail from "./components/CategoryDetail";
import CategoryFormModal from "./components/CategoryFormModal";

export default function IngestConfigPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRead = can(PERM_READ);
  const canManage = can(PERM_MANAGE);

  const catsQ = useQuery({
    queryKey: ["ingest-categories"],
    queryFn: () => ingestApi.categories.list({ limit: 100 }),
    enabled: canRead,
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

  // The nav entry is perm-hidden too, but a deep link shouldn't render an empty
  // shell — say why there's nothing here.
  if (!canRead) {
    return (
      <EmptyState
        icon="heroicons-outline:lock-closed"
        title="Ingest is restricted"
        subtitle={`You need the ${PERM_READ} permission to view ingest configuration.`}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
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
            action={
              canManage ? (
                <button
                  onClick={() => setMode("create")}
                  title="Add category"
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
                >
                  <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
                </button>
              ) : null
            }
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
            canManage={canManage}
            onEdit={() => setMode("edit")}
            onDelete={() =>
              setConfirm({
                title: "Delete category?",
                message:
                  `Delete "${selected.name}"? Its ${selected.webhook_count ?? 0} webhook(s) ` +
                  "will be removed too. This cannot be undone.",
                confirmLabel: "Delete",
                danger: true,
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
