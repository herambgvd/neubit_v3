"use client";

// Right-pane category detail — navy header (edit/delete actions) + the webhooks panel.
import { Icon } from "@iconify/react";

import WebhooksPanel from "./WebhooksPanel";
import { QuietButton, DangerButton } from "@/components/console";

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
        <QuietButton icon="heroicons-outline:pencil-square" onClick={onEdit}>
          Edit
        </QuietButton>
        <DangerButton icon="heroicons-outline:trash" title="Delete category" onClick={onDelete}>
          Delete
        </DangerButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WebhooksPanel category={category} catId={catId} />
      </div>
    </div>
  );
}
