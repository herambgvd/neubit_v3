"use client";

// Right-pane read-only view of the selected tag — color header, status/usage
// meta, description and created/updated timestamps, plus Edit/Delete actions.
import { Icon } from "@iconify/react";

import { DangerButton, QuietButton } from "@/components/console";
import { DEFAULT_COLOR } from "../constants";

const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : "—");

export default function TagDetail({ tag, onEdit, onDelete }: any) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className="inline-flex h-12 w-12 items-center justify-center rounded-xl shrink-0 text-white"
            style={{ background: tag.color || DEFAULT_COLOR }}
          >
            <Icon icon="heroicons:tag" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{tag.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-muted flex-wrap">
              <span className="font-mono">{(tag.color || DEFAULT_COLOR).toUpperCase()}</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  tag.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-white/5 text-nb-muted"
                }`}
              >
                {tag.is_active !== false ? "Active" : "Inactive"}
              </span>
              {typeof tag.usage_count === "number" && (
                <span className="rounded-full bg-white/5 text-nb-muted px-2 py-0.5 font-medium">
                  {tag.usage_count} use(s)
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <QuietButton icon="heroicons-outline:pencil-square" onClick={onEdit} className="!py-1.5 !text-xs">
            Edit
          </QuietButton>
          <DangerButton icon="heroicons-outline:trash" onClick={onDelete} className="!py-1.5 !text-xs">
            Delete
          </DangerButton>
        </div>
      </header>
      <div className="px-6 py-5 space-y-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">Description</div>
          <p className="mt-1 text-sm text-nb-muted">{tag.description || "No description"}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">Created</div>
            <p className="mt-1 text-sm text-nb-ink">{fmtTs(tag.created_at)}</p>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">Updated</div>
            <p className="mt-1 text-sm text-nb-ink">{fmtTs(tag.updated_at)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
