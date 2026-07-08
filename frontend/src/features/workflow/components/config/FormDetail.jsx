"use client";

// Read-only detail pane for a dynamic form (right side of the Forms
// master-detail). Header (name + active badge + edit/delete) over a list of the
// form's fields (label, type, required).
import { Icon } from "@iconify/react";
import { titleize } from "@/lib/format";

export default function FormDetail({ form, onEdit, onDelete }) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500 shrink-0">
            <Icon icon="heroicons-outline:clipboard-document-list" className="text-lg" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground truncate">{form.name}</h2>
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${form.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{form.is_active === false ? "Inactive" : "Active"}</span>
            </div>
            {form.description && <p className="mt-0.5 text-xs text-muted">{form.description}</p>}
            <p className="mt-0.5 text-[11px] text-muted">{fields.length} field(s)</p>
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

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Fields</h3>
        {fields.length === 0 ? (
          <p className="text-sm text-muted">No fields defined.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {fields.map((f, i) => (
              <li key={f.id || i} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">
                    {f.label}
                    {f.validation?.required && <span className="ml-1 text-red-500">*</span>}
                  </div>
                  {f.placeholder && <div className="text-[11px] text-muted truncate">{f.placeholder}</div>}
                </div>
                <span className="text-[10px] rounded-full bg-hover px-2 py-0.5 font-medium text-muted uppercase shrink-0">{titleize(f.type)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
