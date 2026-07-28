"use client";

// Right-pane category detail — navy header (edit/delete actions) + the webhooks panel.
import { Icon } from "@iconify/react";

import WebhooksPanel from "./WebhooksPanel";

export default function CategoryDetail({ category, catId, onEdit, onDelete }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-nb-line px-5 py-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] text-nb-blueb">
          <Icon icon="heroicons-outline:squares-2x2" className="text-xl" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold text-nb-ink">{category.name}</h2>
          {category.description && (
            <p className="truncate text-[11.5px] text-nb-faint">{category.description}</p>
          )}
        </div>
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 rounded-[8px] border border-nb-line px-3 py-1.5 text-[12px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
        >
          <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
        </button>
        <button
          onClick={onDelete}
          title="Delete category"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.1)] text-nb-crit transition hover:bg-[rgba(248,113,113,.18)]"
        >
          <Icon icon="heroicons-outline:trash" className="text-sm" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WebhooksPanel category={category} catId={catId} />
      </div>
    </div>
  );
}
