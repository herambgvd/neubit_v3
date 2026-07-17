"use client";

// Right-pane category detail — header (edit/delete actions) + the webhooks panel.
import { Icon } from "@iconify/react";

import WebhooksPanel from "./WebhooksPanel";

export default function CategoryDetail({ category, catId, onEdit, onDelete, canManage }) {
  return (
    <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
      <div className="flex flex-col flex-1 min-h-0">
        <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
          <div className="flex items-start gap-3 min-w-0">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500 shrink-0">
              <Icon icon="heroicons-outline:squares-2x2" className="text-2xl" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-foreground truncate">{category.name}</h2>
              {category.description && <p className="mt-0.5 text-xs text-muted">{category.description}</p>}
            </div>
          </div>
          {canManage && (
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
                <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
              </button>
              <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
                <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
              </button>
            </div>
          )}
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <WebhooksPanel category={category} catId={catId} canManage={canManage} />
        </div>
      </div>
    </section>
  );
}
