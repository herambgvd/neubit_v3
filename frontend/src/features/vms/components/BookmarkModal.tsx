"use client";

// BookmarkModal (G3) — create or edit a playback bookmark.
//
// A bookmark marks a moment (point) or a span (range) in recorded footage with a
// title + optional note + tags. Opened from the PlaybackPlayer "＋ Bookmark"
// action (seeded with the current playhead time, and the selected window end for
// a range) or from a bookmark's edit affordance in the side panel.
//
// Both create and edit gate on vms.playback.view (the backend enforces it too).
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { BookmarkPublic } from "../types";
import type { IsoSeed } from "./playbackTypes";

// ISO → the value shape a datetime-local input wants (local wall-clock).
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export interface BookmarkModalProps {
  open: boolean;
  onClose?: () => void;
  cameraId: string;
  cameraName?: string | null;
  /** Seed for a new bookmark: { start, end? } (ISO). Ignored when `bookmark` set. */
  seed?: IsoSeed | null;
  /** When set → edit mode. */
  bookmark?: BookmarkPublic | null;
  onSaved?: (bookmark: BookmarkPublic) => void;
}

export default function BookmarkModal({
  open,
  onClose,
  cameraId,
  cameraName,
  seed = null,
  bookmark = null,
  onSaved,
}: BookmarkModalProps) {
  const editing = !!bookmark;
  const [startTs, setStartTs] = useState("");
  const [endTs, setEndTs] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (bookmark) {
      setStartTs(toLocalInput(bookmark.start_ts));
      setEndTs(toLocalInput(bookmark.end_ts));
      setTitle(bookmark.title || "");
      setNote(bookmark.note || "");
      setTags((bookmark.tags || []).join(", "));
    } else {
      setStartTs(toLocalInput(seed?.start));
      setEndTs(toLocalInput(seed?.end));
      setTitle("");
      setNote("");
      setTags("");
    }
    setSaving(false);
  }, [open, bookmark, seed?.start, seed?.end]);

  const startIso = fromLocalInput(startTs);
  const endIso = fromLocalInput(endTs);
  const rangeValid = !endIso || (!!startIso && new Date(endIso) > new Date(startIso));
  const canSave = !!title.trim() && !!startIso && rangeValid;

  const save = async () => {
    if (!canSave || !startIso) return; // `canSave` already implies a start; this narrows it
    setSaving(true);
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      if (bookmark) {
        const res = await vms.bookmarks.update(bookmark.id, {
          start_ts: startIso,
          end_ts: endIso,
          title: title.trim(),
          note: note.trim() || null,
          tags: tagList,
        });
        toast.success("Bookmark updated");
        onSaved?.(res);
      } else {
        const res = await vms.bookmarks.create({
          camera_id: cameraId,
          start_ts: startIso,
          end_ts: endIso || undefined,
          title: title.trim(),
          note: note.trim() || undefined,
          tags: tagList,
        });
        toast.success("Bookmark added");
        onSaved?.(res);
      }
      onClose?.();
    } catch (e) {
      toast.error(apiError(e, "Could not save the bookmark"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit bookmark" : "Add bookmark"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="heroicons-outline:bookmark"
            disabled={!canSave || saving}
            onClick={save}
          >
            {saving ? "Saving…" : editing ? "Save" : "Add bookmark"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.08)]/40 px-3 py-2 text-sm">
          <span className="text-[#aec2e8]">Camera</span>{" "}
          <span className="font-medium text-[#f2f6ff]">{cameraName || cameraId}</span>
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What happened at this moment?"
            maxLength={255}
            className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
          />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">At (start)</span>
            <input
              type="datetime-local"
              value={startTs}
              onChange={(e) => setStartTs(e.target.value)}
              className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">
              Until (optional — range)
            </span>
            <input
              type="datetime-local"
              value={endTs}
              onChange={(e) => setEndTs(e.target.value)}
              className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
            />
          </label>
        </div>
        {!rangeValid && (
          <p className="text-xs text-amber-500">The end time must be after the start time.</p>
        )}

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">Note</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Optional context…"
            className="w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 py-2 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">
            Tags (comma-separated)
          </span>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="intrusion, review, incident-42"
            className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
          />
        </label>
      </div>
    </Modal>
  );
}
