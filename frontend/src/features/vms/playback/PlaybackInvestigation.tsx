"use client";

// PlaybackInvestigation — the side panel of the Playback workspace (SCRUM-307).
//
// What every investigation client keeps next to the video (Milestone's Search,
// Avigilon's search panes, Genetec's Bookmarks task): the events on the loaded
// cameras, the bookmarks on them, a motion search, and the exports this session
// raised. Every row is a jump: click it and the grid plays from there.
//
// Bookmarks are the RECORDER's: made here, they are stored beside the footage on
// the recorder that owns the camera, so its own console shows them too.
import { useState } from "react";
import { Icon } from "@iconify/react";

import type { WallClock } from "../hooks/useWallPlayback";
import { clockText, localDay } from "./playbackModel";

export interface InvEvent {
  key: string;
  camKey: string;
  camName: string;
  at: number;
  type: string;
}

export interface InvBookmark {
  id: string;
  camKey: string;
  camName: string;
  nodeId: string;
  at: number;
  label: string;
  note?: string | null;
}

export interface InvExport {
  id: string;
  nodeId: string;
  camName: string;
  from: string;
  to: string;
  status: string;
  error?: string | null;
}

export interface InvMotion {
  camName: string;
  hits: { s: number; e: number; score: number }[];
  note: string;
}

type Tab = "events" | "bookmarks" | "motion" | "exports";

export interface PlaybackInvestigationProps {
  clock: WallClock;
  activeCamName: string | null;
  events: InvEvent[];
  bookmarks: InvBookmark[];
  bookmarksFailed: boolean;
  motion: InvMotion | null;
  exportsList: InvExport[];
  canExportAll: boolean;
  selectionText: string | null;
  onSeek: (ms: number, camKey?: string) => void;
  onAddBookmark: (label: string, note: string) => Promise<boolean>;
  onDeleteBookmark: (b: InvBookmark) => void;
  onMotionSearch: () => void;
  onClearMotion: () => void;
  onExportAll: () => void;
  onDownload: (e: InvExport) => void;
  onClose: () => void;
}

const when = (ms: number) => `${localDay(ms).slice(5)} ${clockText(ms)}`;

export default function PlaybackInvestigation(p: Readonly<PlaybackInvestigationProps>) {
  const [tab, setTab] = useState<Tab>("events");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "events", label: "Events", count: p.events.length },
    { id: "bookmarks", label: "Bookmarks", count: p.bookmarks.length },
    { id: "motion", label: "Motion", count: p.motion?.hits.length },
    { id: "exports", label: "Exports", count: p.exportsList.length },
  ];

  const save = async () => {
    if (!label.trim()) return;
    setSaving(true);
    const ok = await p.onAddBookmark(label.trim(), note.trim());
    setSaving(false);
    if (ok) {
      setLabel("");
      setNote("");
    }
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col rounded-xl border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.55)]">
      <div className="flex items-center gap-1 border-b border-[rgba(160,150,245,.22)] px-2 py-1.5">
        <Icon icon="heroicons-outline:magnifying-glass-circle" className="text-sm text-[#9db0d8]" />
        <span className="text-[12px] font-medium">Investigate</span>
        <button
          type="button"
          aria-label="Close the investigation panel"
          onClick={p.onClose}
          className="ml-auto rounded p-0.5 text-[#9db0d8] hover:text-[#f2f6ff]"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>
      <div className="flex border-b border-[rgba(160,150,245,.22)]" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-1 py-1.5 text-[11px] transition ${
              tab === t.id ? "border-b-2 border-[#22d3ee] text-[#67e8f9]" : "text-[#9db0d8] hover:text-[#f2f6ff]"
            }`}
          >
            {t.label}
            {t.count ? <span className="ml-0.5 tabular-nums opacity-70">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-2 text-[12px]">
        {tab === "events" && (
          <List empty="No events on these cameras in the visible window.">
            {p.events.map((e) => (
              <Row key={e.key} onClick={() => p.onSeek(e.at - 5_000, e.camKey)}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#fde047]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[#f2f6ff]">{e.type}</span>
                  <span className="block truncate text-[10.5px] text-[#9db0d8]">{e.camName}</span>
                </span>
                <span className="shrink-0 tabular-nums text-[10.5px] text-[#9db0d8]">{when(e.at)}</span>
              </Row>
            ))}
          </List>
        )}

        {tab === "bookmarks" && (
          <div className="space-y-2">
            <div className="rounded-lg border border-[rgba(160,150,245,.18)] p-2">
              <p className="mb-1 text-[10.5px] text-[#9db0d8]">
                {p.activeCamName
                  ? `Bookmark ${p.activeCamName} at the playhead — stored on its recorder.`
                  : "Click a tile to choose the camera to bookmark."}
              </p>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={200}
                placeholder="What happened (required)"
                aria-label="Bookmark label"
                className="mb-1 w-full rounded-md border border-[rgba(160,150,245,.22)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[#22d3ee]"
              />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="Note (optional)"
                aria-label="Bookmark note"
                className="mb-1 w-full resize-none rounded-md border border-[rgba(160,150,245,.22)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[#22d3ee]"
              />
              <button
                type="button"
                disabled={!label.trim() || !p.activeCamName || saving}
                onClick={() => void save()}
                className="w-full rounded-md bg-[#22d3ee] py-1 text-[12px] font-semibold text-[#04111f] disabled:opacity-40"
              >
                {saving ? "Saving…" : "Add bookmark"}
              </button>
            </div>
            {p.bookmarksFailed && (
              <p className="text-[10.5px] leading-relaxed text-amber-200">
                Some recorders did not return bookmarks. A recorder paired before this release needs a
                re-pair (Recorders → Re-pair with code) to share them.
              </p>
            )}
            <List empty="No bookmarks in the visible window.">
              {p.bookmarks.map((b) => (
                <Row
                  key={`${b.nodeId}:${b.id}`}
                  onClick={() => p.onSeek(b.at - 3_000, b.camKey)}
                  trailing={
                    <button
                      type="button"
                      aria-label={`Delete bookmark ${b.label}`}
                      onClick={() => p.onDeleteBookmark(b)}
                      className="shrink-0 rounded p-0.5 text-[#9db0d8] hover:text-red-300"
                    >
                      <Icon icon="heroicons-outline:trash" className="text-[12px]" />
                    </button>
                  }
                >
                  <Icon icon="heroicons-solid:bookmark" className="shrink-0 text-[#38bdf8]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[#f2f6ff]">{b.label}</span>
                    <span className="block truncate text-[10.5px] text-[#9db0d8]">
                      {b.camName}
                      {b.note ? ` · ${b.note}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[10.5px] text-[#9db0d8]">{when(b.at)}</span>
                </Row>
              ))}
            </List>
          </div>
        )}

        {tab === "motion" && (
          <div className="space-y-2">
            <button
              type="button"
              disabled={!p.activeCamName}
              onClick={p.onMotionSearch}
              className="w-full rounded-md border border-[rgba(34,211,238,.45)] py-1.5 text-[12px] text-[#67e8f9] transition hover:bg-[rgba(34,211,238,.08)] disabled:opacity-40"
            >
              {p.activeCamName ? `Search motion on ${p.activeCamName}…` : "Click a tile to search its motion"}
            </button>
            <p className="text-[10.5px] leading-relaxed text-[#9db0d8]">
              Draw a region; the recorder scans its own footage for pixel change there — the IN/OUT
              range if one is marked{p.selectionText ? ` (${p.selectionText})` : ""}, else the visible
              window, up to 6 hours. Pixel change, not object detection.
            </p>
            {p.motion && (
              <>
                <div className="flex items-center justify-between text-[10.5px] text-[#9db0d8]">
                  <span>
                    {p.motion.camName}: {p.motion.hits.length} hit{p.motion.hits.length === 1 ? "" : "s"}
                  </span>
                  <button type="button" onClick={p.onClearMotion} className="hover:text-[#f2f6ff]">
                    Clear
                  </button>
                </div>
                {p.motion.note && <p className="text-[10.5px] text-amber-200">{p.motion.note}</p>}
                <List empty="No motion in that region.">
                  {p.motion.hits.map((h) => (
                    <Row key={h.s} onClick={() => p.onSeek(h.s - 2_000)}>
                      <span className="h-2 w-2 shrink-0 rounded-sm border border-[#4ade80]" />
                      <span className="flex-1 tabular-nums text-[#f2f6ff]">{when(h.s)}</span>
                      <span className="shrink-0 tabular-nums text-[10.5px] text-[#9db0d8]">
                        {Math.max(1, Math.round((h.e - h.s) / 1000))}s
                      </span>
                    </Row>
                  ))}
                </List>
              </>
            )}
          </div>
        )}

        {tab === "exports" && (
          <div className="space-y-2">
            <button
              type="button"
              disabled={!p.canExportAll}
              onClick={p.onExportAll}
              title={p.canExportAll ? undefined : "Mark IN and OUT on the timeline first"}
              className="w-full rounded-md border border-[rgba(34,211,238,.45)] py-1.5 text-[12px] text-[#67e8f9] transition hover:bg-[rgba(34,211,238,.08)] disabled:opacity-40"
            >
              Export every camera in the grid{p.selectionText ? ` · ${p.selectionText}` : ""}
            </button>
            <p className="text-[10.5px] leading-relaxed text-[#9db0d8]">
              Each recorder cuts its own cameras&apos; clips and signs a chain-of-custody manifest. The
              download icon on the transport exports just the active camera, with verify and watermark
              options.
            </p>
            <List empty="No exports raised in this session.">
              {p.exportsList.map((x) => (
                <div key={`${x.nodeId}:${x.id}`} className="flex items-center gap-2 rounded-md px-1.5 py-1">
                  <ExportIcon status={x.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[#f2f6ff]">{x.camName}</span>
                    <span className="block truncate text-[10.5px] text-[#9db0d8]">
                      {clockText(new Date(x.from).getTime())}–{clockText(new Date(x.to).getTime())} · {x.status}
                      {x.error ? ` · ${x.error}` : ""}
                    </span>
                  </span>
                  {x.status === "done" && (
                    <button
                      type="button"
                      aria-label={`Download the ${x.camName} clip`}
                      onClick={() => p.onDownload(x)}
                      className="shrink-0 rounded p-0.5 text-[#67e8f9] hover:text-[#f2f6ff]"
                    >
                      <Icon icon="heroicons-outline:arrow-down-tray" className="text-[13px]" />
                    </button>
                  )}
                </div>
              ))}
            </List>
          </div>
        )}
      </div>
    </aside>
  );
}

function List({ empty, children }: Readonly<{ empty: string; children: React.ReactNode[] }>) {
  if (!children.length) return <p className="px-1 py-3 text-center text-[11px] text-[#9db0d8]">{empty}</p>;
  return <div className="space-y-0.5">{children}</div>;
}

interface RowProps {
  onClick: () => void;
  children: React.ReactNode;
  /** A control beside the row (delete), kept outside the row's own button. */
  trailing?: React.ReactNode;
}

function Row({ onClick, children, trailing }: Readonly<RowProps>) {
  return (
    <div className="flex items-center gap-1 rounded-md pr-1 transition hover:bg-[rgba(150,180,245,.08)]">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left">
        {children}
      </button>
      {trailing}
    </div>
  );
}

function ExportIcon({ status }: Readonly<{ status: string }>) {
  if (status === "done") return <Icon icon="heroicons-solid:check-circle" className="shrink-0 text-emerald-400" />;
  if (status === "failed") return <Icon icon="heroicons-solid:x-circle" className="shrink-0 text-red-400" />;
  return <Icon icon="svg-spinners:180-ring" className="shrink-0 text-[#9db0d8]" />;
}
