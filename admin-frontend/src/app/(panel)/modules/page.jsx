"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, Loader2, Lock, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";

function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

function CategoryBadge({ category }) {
  if (!category) return <span className="text-slate-500">—</span>;
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium capitalize text-slate-300">
      {category}
    </span>
  );
}

export default function ModulesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["modules"],
    queryFn: () => adminApi.listModules(),
  });

  const modules = normalize(data);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return modules;
    return modules.filter(
      (m) =>
        (m.key || "").toLowerCase().includes(needle) ||
        (m.name || "").toLowerCase().includes(needle) ||
        (m.category || "").toLowerCase().includes(needle)
    );
  }, [modules, q]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["modules"] });

  const del = useMutation({
    mutationFn: (key) => adminApi.deleteModule(key),
    onSuccess: () => {
      toast.success("Module deleted");
      invalidate();
    },
    onError: (err) => toast.error(apiError(err, "Could not delete module")),
  });

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Modules</h1>
          <p className="mt-1 text-sm text-slate-400">
            The feature catalog every tenant inherits. Toggle defaults or add new capabilities.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
        >
          <Plus className="h-4 w-4" />
          Add module
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search key, name or category…"
            className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.04] pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 font-medium">Module</th>
              <th className="px-5 py-3 font-medium">Category</th>
              <th className="px-5 py-3 font-medium">Default</th>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows />}

            {isError && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-sm text-red-300">
                  {apiError(error, "Failed to load modules")}
                </td>
              </tr>
            )}

            {!isLoading && !isError && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-cyan-300">
                      <Blocks className="h-5 w-5" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-slate-200">
                      {q ? "No matching modules" : "No modules yet"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {q ? "Try a different search." : "Add your first module."}
                    </p>
                  </div>
                </td>
              </tr>
            )}

            {!isLoading &&
              !isError &&
              filtered.map((m) => (
                <tr key={m.key} className="border-b border-white/5 last:border-0 transition hover:bg-white/[0.03]">
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-white">{m.name || m.key}</div>
                    <div className="font-mono text-xs text-slate-500">{m.key}</div>
                    {m.description && (
                      <div className="mt-0.5 max-w-md text-xs text-slate-500">{m.description}</div>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <CategoryBadge category={m.category} />
                  </td>
                  <td className="px-5 py-3.5">
                    {m.default_enabled ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        On
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-slate-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                        Off
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    {m.is_system ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-medium text-cyan-300">
                        <Lock className="h-3 w-3" />
                        System
                      </span>
                    ) : (
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-slate-400">
                        Custom
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        title="Edit"
                        aria-label="Edit"
                        onClick={() => setEditing(m)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-300"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title={m.is_system ? "System modules can't be deleted" : "Delete"}
                        aria-label="Delete"
                        disabled={m.is_system || del.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete module "${m.name || m.key}"?`)) del.mutate(m.key);
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-slate-400 transition hover:border-red-400/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-slate-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-slate-500">
        {modules.length} module{modules.length === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </div>

      {showCreate && (
        <ModuleModal
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            invalidate();
          }}
        />
      )}
      {editing && (
        <ModuleModal
          module={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function SkeletonRows() {
  return Array.from({ length: 5 }).map((_, i) => (
    <tr key={i} className="border-b border-white/5 last:border-0">
      {Array.from({ length: 5 }).map((__, j) => (
        <td key={j} className="px-5 py-4">
          <div className="h-3.5 w-full max-w-[120px] animate-pulse rounded bg-white/10" />
        </td>
      ))}
    </tr>
  ));
}

function ModuleModal({ module, onClose, onSaved }) {
  const isEdit = !!module;
  const [key, setKey] = useState(module?.key || "");
  const [name, setName] = useState(module?.name || "");
  const [description, setDescription] = useState(module?.description || "");
  const [category, setCategory] = useState(module?.category || "");
  const [defaultEnabled, setDefaultEnabled] = useState(module?.default_enabled ?? true);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim(),
        category: category.trim(),
        default_enabled: defaultEnabled,
      };
      if (isEdit) return adminApi.updateModule(module.key, body);
      return adminApi.createModule({ key: key.trim(), ...body });
    },
    onSuccess: () => {
      toast.success(isEdit ? "Module updated" : "Module created");
      onSaved();
    },
    onError: (err) => toast.error(apiError(err, "Could not save module")),
  });

  function onSubmit(e) {
    e.preventDefault();
    if (save.isPending) return;
    if (!isEdit && !key.trim()) {
      toast.error("Key is required");
      return;
    }
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    save.mutate();
  }

  const inputCls =
    "h-11 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 hover:border-white/20";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-modal-in relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0a0a] p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-white">
              {isEdit ? "Edit module" : "Add module"}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {isEdit ? "Update this platform feature." : "Register a new platform feature."}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Key">
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="video_analytics"
              autoFocus={!isEdit}
              disabled={isEdit}
              required
              className={inputCls + (isEdit ? " opacity-60" : "")}
            />
          </Field>
          <Field label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Video Analytics" autoFocus={isEdit} required className={inputCls} />
          </Field>
          <Field label="Category">
            <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="analytics" className={inputCls} />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this module does…"
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 hover:border-white/20"
            />
          </Field>
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Enabled by default</div>
              <div className="text-xs text-slate-500">New tenants inherit this state.</div>
            </div>
            <input
              type="checkbox"
              checked={defaultEnabled}
              onChange={(e) => setDefaultEnabled(e.target.checked)}
              className="h-4 w-4 accent-cyan-400"
            />
          </label>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled={save.isPending} className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60">
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? "Save changes" : "Add module"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}
