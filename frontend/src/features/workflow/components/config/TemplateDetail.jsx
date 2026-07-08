"use client";

// Read-only detail pane for a notification template (right side of the
// Notifications master-detail). Header (name + channel + edit/delete) over the
// subject and the rendered body text.
import { Icon } from "@iconify/react";
import { titleize } from "@/lib/format";

export default function TemplateDetail({ template, onEdit, onDelete }) {
  const t = template;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-purple-500/10 text-purple-500 shrink-0">
            <Icon icon="heroicons-outline:bell-alert" className="text-lg" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground truncate">{t.name}</h2>
              <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted uppercase">{titleize(t.channel_type)}</span>
              {t.is_active === false && <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted">Inactive</span>}
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

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        {t.description && (
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted/70">Description</div>
            <div className="text-sm text-muted">{t.description}</div>
          </div>
        )}
        {t.provider_template_ref && (
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted/70">Provider template ref</div>
            <div className="text-sm font-mono text-foreground">{t.provider_template_ref}</div>
          </div>
        )}
        {t.subject && (
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted/70">Subject</div>
            <div className="text-sm text-foreground">{t.subject}</div>
          </div>
        )}
        <div>
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted/70">Body</div>
          <pre className="whitespace-pre-wrap rounded-lg border border-card-border bg-hover/40 px-3 py-2.5 text-xs font-mono text-foreground">{t.body || "—"}</pre>
        </div>
      </div>
    </div>
  );
}
