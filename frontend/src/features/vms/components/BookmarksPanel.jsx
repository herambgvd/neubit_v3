"use client";

// BookmarksPanel (G3) — the bookmarks + evidence-holds side rail for the current
// camera on the Playback surface. Two collapsible lists:
//   • Bookmarks   — click to seek, edit, or delete (vms.playback.view).
//   • Evidence    — active legal holds; release or delete (vms.recording.control).
//
// Presentational: the parent owns the queried data + wires the callbacks.
import { Icon } from "@iconify/react";

import { fmtDateTime } from "@/lib/format";

function timeLabel(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}

export default function BookmarksPanel({
  bookmarks = [],
  locks = [],
  loading = false,
  canLock = false,
  onSeek, // (ms) => void
  onEditBookmark,
  onDeleteBookmark,
  onReleaseLock,
  onDeleteLock,
  className = "",
}) {
  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {/* Bookmarks */}
      <section className="rounded-xl border border-card-border bg-card">
        <header className="flex items-center gap-2 border-b border-card-border px-4 py-3">
          <Icon icon="heroicons-outline:bookmark" className="text-base text-sky-400" />
          <h3 className="text-sm font-semibold text-foreground">Bookmarks</h3>
          <span className="ml-auto rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
            {bookmarks.length}
          </span>
        </header>
        <div className="max-h-72 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-6 text-center text-xs text-muted">Loading…</p>
          ) : bookmarks.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted">
              No bookmarks. Use “＋ Bookmark” to flag a moment.
            </p>
          ) : (
            bookmarks.map((b) => (
              <div
                key={b.id}
                className="group flex items-start gap-2 border-b border-card-border px-4 py-2.5 last:border-0 hover:bg-hover/40"
              >
                <button
                  type="button"
                  onClick={() => onSeek?.(new Date(b.start_ts).getTime())}
                  className="min-w-0 flex-1 text-left"
                  title="Seek to bookmark"
                >
                  <p className="truncate text-sm font-medium text-foreground">{b.title}</p>
                  <p className="text-[11px] text-muted">
                    {timeLabel(b.start_ts)}
                    {b.end_ts ? ` – ${timeLabel(b.end_ts)}` : ""}
                  </p>
                  {b.note && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{b.note}</p>}
                  {b.tags?.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {b.tags.map((t) => (
                        <span key={t} className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <IconBtn icon="heroicons-outline:pencil-square" title="Edit" onClick={() => onEditBookmark?.(b)} />
                  <IconBtn icon="heroicons-outline:trash" title="Delete" danger onClick={() => onDeleteBookmark?.(b)} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Evidence holds */}
      <section className="rounded-xl border border-card-border bg-card">
        <header className="flex items-center gap-2 border-b border-card-border px-4 py-3">
          <Icon icon="heroicons-outline:lock-closed" className="text-base text-amber-500" />
          <h3 className="text-sm font-semibold text-foreground">Evidence holds</h3>
          <span className="ml-auto rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
            {locks.length}
          </span>
        </header>
        <div className="max-h-72 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-6 text-center text-xs text-muted">Loading…</p>
          ) : locks.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted">
              No active holds on this camera.
            </p>
          ) : (
            locks.map((l) => (
              <div
                key={l.id}
                className="group flex items-start gap-2 border-b border-card-border px-4 py-2.5 last:border-0 hover:bg-hover/40"
              >
                <button
                  type="button"
                  onClick={() => onSeek?.(new Date(l.start_ts).getTime())}
                  className="min-w-0 flex-1 text-left"
                  title="Seek to hold start"
                >
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                    <Icon icon="heroicons-solid:shield-check" className="shrink-0 text-xs text-amber-500" />
                    {l.case_ref || "Legal hold"}
                  </p>
                  <p className="text-[11px] text-muted">
                    {fmtDateTime(l.start_ts)} → {timeLabel(l.end_ts)}
                  </p>
                  {l.reason && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{l.reason}</p>}
                </button>
                {canLock && (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <IconBtn
                      icon="heroicons-outline:lock-open"
                      title="Release hold"
                      onClick={() => onReleaseLock?.(l)}
                    />
                    <IconBtn
                      icon="heroicons-outline:trash"
                      title="Delete hold"
                      danger
                      onClick={() => onDeleteLock?.(l)}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function IconBtn({ icon, title, onClick, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-hover ${
        danger ? "text-muted hover:text-red-500" : "text-muted hover:text-foreground"
      }`}
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}
