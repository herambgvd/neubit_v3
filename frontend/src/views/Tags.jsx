"use client";

// Tags configuration — cross-cutting, color-coded labels usable across modules
// (sites/zones today, devices/incidents later). Matches the neubit_v3 operator page
// style: PageHeader + a left search list, a right create/edit form, sonner toasts,
// TanStack Query, kit components + semantic theme tokens.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { tags as tagsApi } from "@/lib/api/tags";

const DEFAULT_COLOR = "#3B82F6";
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
// A quick palette of preset swatches (Tailwind-ish) for one-click color pick.
const SWATCHES = [
  "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899", "#EF4444",
  "#F59E0B", "#10B981", "#14B8A6", "#0EA5E9", "#64748B",
];

const FIELD_CLS =
  "mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted";

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
    <div>
      <PageHeader
        title="Tags"
        subtitle="Color-coded labels you can attach across sites, zones and more."
        actions={
          <Button
            variant="success"
            icon="heroicons-outline:plus"
            onClick={() => {
              setSelectedId(null);
              setMode("create");
            }}
          >
            Add tag
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] gap-4 min-h-[70vh]">
        {/* ── Left list ─────────────────────────────────────────── */}
        <aside className="rounded-xl border border-card-border bg-card flex flex-col min-h-0">
          <header className="flex items-center justify-between px-4 py-3 border-b border-card-border">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Tags</span>
              <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                {total}
              </span>
            </div>
          </header>
          <div className="p-3">
            <label className="relative block">
              <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-base" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tags…"
                className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
              />
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {tagsQ.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons:tag" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {q.trim() ? "No tags match your search" : "No tags yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {q.trim() ? "Try a different keyword." : "Click Add tag to create your first tag."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((t) => {
                  const isSelected = t.tag_id === selectedId && mode !== "create";
                  return (
                    <li key={t.tag_id} className="relative">
                      <button
                        onClick={() => {
                          setSelectedId(t.tag_id);
                          setMode("view");
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition ${
                          isSelected ? "bg-hover" : "hover:bg-hover"
                        }`}
                      >
                        {isSelected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
                        <span
                          className="h-4 w-4 rounded-full border border-card-border shrink-0"
                          style={{ background: t.color || DEFAULT_COLOR }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground truncate">{t.name}</span>
                            {t.is_active === false && (
                              <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium">Inactive</span>
                            )}
                          </span>
                          {t.description && <span className="block text-xs text-muted truncate">{t.description}</span>}
                        </span>
                        {typeof t.usage_count === "number" && t.usage_count > 0 && (
                          <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium shrink-0">
                            {t.usage_count}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right detail / form ───────────────────────────────── */}
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
      </div>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

/* ─── Tag detail ─────────────────────────────────────────────────── */
function TagDetail({ tag, onEdit, onDelete }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className="inline-flex h-12 w-12 items-center justify-center rounded-xl shrink-0 text-white"
            style={{ background: tag.color || DEFAULT_COLOR }}
          >
            <Icon icon="heroicons:tag" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{tag.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted flex-wrap">
              <span className="font-mono">{(tag.color || DEFAULT_COLOR).toUpperCase()}</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  tag.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
                }`}
              >
                {tag.is_active !== false ? "Active" : "Inactive"}
              </span>
              {typeof tag.usage_count === "number" && (
                <span className="rounded-full bg-hover text-muted px-2 py-0.5 font-medium">
                  {tag.usage_count} use(s)
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>
      <div className="px-6 py-5 space-y-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Description</div>
          <p className="mt-1 text-sm text-muted">{tag.description || "No description"}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Created</div>
            <p className="mt-1 text-sm text-foreground">{tag.created_at ? new Date(tag.created_at).toLocaleString() : "—"}</p>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Updated</div>
            <p className="mt-1 text-sm text-foreground">{tag.updated_at ? new Date(tag.updated_at).toLocaleString() : "—"}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Tag create / edit form ─────────────────────────────────────── */
function TagForm({ tag, onCancel, onSaved }) {
  const isEdit = !!tag;
  const [name, setName] = useState(tag?.name || "");
  const [color, setColor] = useState(tag?.color || DEFAULT_COLOR);
  const [description, setDescription] = useState(tag?.description || "");
  const [isActive, setIsActive] = useState(tag?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? tagsApi.update(tag.tag_id, body) : tagsApi.create(body)),
    onSuccess: (saved) => {
      setErrors({});
      toast.success(isEdit ? "Tag updated" : "Tag created");
      onSaved(saved);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!HEX_RE.test(color)) next.color = "Color must be a 6-digit hex (e.g. #3B82F6)";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      color,
      description: description.trim() || null,
    };
    if (isEdit) body.is_active = isActive;
    saving.mutate(body);
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col flex-1 min-h-0">
      <header className="flex items-center justify-between px-6 py-5 border-b border-card-border">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: HEX_RE.test(color) ? color : DEFAULT_COLOR }}>
            <Icon icon="heroicons:tag" className="text-xl" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{isEdit ? `Edit ${tag.name}` : "Create tag"}</h2>
            <p className="text-xs text-muted mt-0.5">
              {isEdit ? "Update this label's name, color or description." : "Add a new cross-cutting label."}
            </p>
          </div>
        </div>
        <button type="button" onClick={onCancel} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-base" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 space-y-5">
        <div className="max-w-lg space-y-5">
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted">
              Name <span className="text-red-500 ml-1">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
              }}
              placeholder="Enter tag name"
              className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`}
            />
            {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
          </div>

          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted">Color</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={HEX_RE.test(color) ? color : DEFAULT_COLOR}
                onChange={(e) => {
                  setColor(e.target.value);
                  if (errors.color) setErrors((p) => ({ ...p, color: undefined }));
                }}
                className="h-10 w-16 rounded-md border border-field cursor-pointer bg-transparent"
              />
              <input
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  if (errors.color) setErrors((p) => ({ ...p, color: undefined }));
                }}
                className={`h-10 flex-1 rounded-md border border-field bg-transparent px-3 text-sm font-mono text-foreground outline-none focus:border-muted ${errors.color ? "!border-red-500" : ""}`}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => {
                    setColor(c);
                    if (errors.color) setErrors((p) => ({ ...p, color: undefined }));
                  }}
                  className={`h-6 w-6 rounded-full border transition ${
                    color?.toUpperCase() === c ? "border-foreground scale-110" : "border-card-border"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
            {errors.color && <p className="mt-1 text-xs text-red-500">{errors.color}</p>}
          </div>

          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted">Description</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tag description (optional)"
              className="mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
            />
          </div>

          {isEdit && (
            <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-field bg-transparent text-sm cursor-pointer w-fit">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              <span className="text-foreground">Active</span>
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="success" disabled={saving.isPending}>
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create tag"}
        </Button>
      </div>
    </form>
  );
}
