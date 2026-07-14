"use client";

// PlaybackPlayer — the P4-C recorded-video surface for a single camera.
//
// Plays a RECORDED PlaybackSession (an HLS window `[from,to]`) via hls.js — the
// same plumbing as the live LivePlayer, but HLS-only (recorded playback is never
// WebRTC). The video's currentTime maps to `windowStart + video.currentTime`, so
// scrubbing within the loaded day just seeks the <video>; changing day re-issues
// the session over the new window.
//
// Two shapes:
//   • Standalone (default): coverage/gaps timeline from `/timeline`, its own
//     transport (play/pause, speed 0.5/1/2/4×, frame-step, current-time readout,
//     day picker), snapshot, and an "export this range" hook.
//   • Slaved (props.controlled): a bare video cell driven by a shared clock for
//     synchronized multi-camera playback — no chrome, transport comes from the
//     parent via `playing`/`speed`/`seekMs`.
//
// A `sourceFn` override lets this same player render NVR-footage sessions, which
// return the same session shape from a different endpoint.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { asItems } from "@/lib/format";
import { vms } from "../api";
import { usePlaybackSession } from "../hooks/usePlaybackSession";
import ScrubBar from "./ScrubBar";
import BookmarkModal from "./BookmarkModal";
import EvidenceLockModal from "./EvidenceLockModal";
import BookmarksPanel from "./BookmarksPanel";
import MotionSearchModal from "./MotionSearchModal";

const SPEEDS = [0.5, 1, 2, 4];
const DAY_MS = 86_400_000;

const todayStr = () => new Date().toISOString().slice(0, 10);
const dayStartMs = (dayStr) => new Date(`${dayStr}T00:00:00`).getTime();
const iso = (ms) => new Date(ms).toISOString();

function readout(ms) {
  if (ms == null) return "--:--:--";
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

export default function PlaybackPlayer({
  cameraId,
  cameraName,
  profile = "main",
  // Recorded-source override (NVR footage). When set, timeline/coverage come
  // from `timelineFn` and the session from `sourceFn`.
  sourceFn = null,
  timelineFn = null,
  // Deep-link seek (jump-to-recording from a camera event): an ISO timestamp to
  // open the player on that day + seek the scrub bar to that instant once ready.
  initialSeek = null,
  // Controlled (slaved) mode — for synchronized multi-cam. The parent owns the
  // clock; this cell just follows it.
  controlled = false,
  playing = false,
  speed = 1,
  seekMs = null, // epoch ms the parent wants everyone at
  windowStart: extWindowStart = null,
  windowEnd: extWindowEnd = null,
  onClock, // (ms) => void — report this cell's playback position (slaved lead cell)
  onExportRange, // ({ from, to }) => void — open the export dialog for this window
  className = "",
}) {
  // When opened via a deep-link seek, start on that instant's day so its window
  // (and coverage) load; else today.
  const initialDay = useMemo(() => {
    if (initialSeek) {
      const d = new Date(initialSeek);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return todayStr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [day, setDay] = useState(initialDay);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localSpeed, setLocalSpeed] = useState(1);
  const [current, setCurrent] = useState(null); // epoch ms of the playhead
  const [videoError, setVideoError] = useState(false);

  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const seekingRef = useRef(false);

  // The visible window. Standalone: the whole selected day. Controlled: the
  // parent-provided shared window (falls back to the day).
  const windowStart = controlled && extWindowStart != null ? extWindowStart : dayStartMs(day);
  const windowEnd = controlled && extWindowEnd != null ? extWindowEnd : windowStart + DAY_MS;

  // ── Timeline (coverage + gaps) — standalone only ────────────────────────
  const timelineQ = useQuery({
    queryKey: ["vms-timeline", cameraId, day, !!sourceFn],
    queryFn: () => (timelineFn ? timelineFn({ day }) : vms.playback.timeline(cameraId, { day })),
    enabled: !controlled && !!cameraId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const coverage = useMemo(() => {
    const d = timelineQ.data;
    if (!d) return [];
    // Accept {coverage:[...]} or a bare array of {start,end}.
    return Array.isArray(d) ? d : d.coverage || [];
  }, [timelineQ.data]);

  // Event markers (P5-B/C) — VmsEvent ticks the ScrubBar plots (color by severity).
  // { t, event_type, severity, event_id } from the timeline response.
  const markers = useMemo(() => {
    const d = timelineQ.data;
    if (!d || Array.isArray(d)) return [];
    return d.markers || [];
  }, [timelineQ.data]);

  // Coverage passed down in controlled mode via props isn't needed; the parent
  // renders the shared scrub bar.

  // ── Bookmarks + evidence holds (G3) — standalone only ───────────────────
  const qc = useQueryClient();
  const { can } = useAuth();
  const canLock = can("vms.recording.control");
  const canSearch = can("vms.playback.view");
  // ── Smart / forensic motion search (G4) — standalone only ───────────────
  const [motionSearchOpen, setMotionSearchOpen] = useState(false);
  const [motionHits, setMotionHits] = useState([]); // [{ start, end?, score? }]
  const [bookmarkSeed, setBookmarkSeed] = useState(null); // { start, end? } | null → open create
  const [editBookmark, setEditBookmark] = useState(null); // bookmark row | null → open edit
  const [lockSeed, setLockSeed] = useState(null); // { start, end } | null → open lock modal
  const [activeBookmark, setActiveBookmark] = useState(null); // popover after clicking a flag

  // Query bookmarks + active holds for this camera over the loaded window.
  const bookmarksQ = useQuery({
    queryKey: ["vms-bookmarks", cameraId, iso(windowStart), iso(windowEnd)],
    queryFn: () =>
      vms.bookmarks.list({ camera_id: cameraId, from: iso(windowStart), to: iso(windowEnd), limit: 500 }),
    enabled: !controlled && !sourceFn && !!cameraId,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const bookmarks = useMemo(() => asItems(bookmarksQ.data), [bookmarksQ.data]);

  const locksQ = useQuery({
    queryKey: ["vms-evidence", cameraId],
    queryFn: () => vms.evidence.list({ camera_id: cameraId, active_only: true, limit: 500 }),
    enabled: !controlled && !sourceFn && !!cameraId,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const locks = useMemo(() => asItems(locksQ.data), [locksQ.data]);

  const invalidateBookmarks = () => qc.invalidateQueries({ queryKey: ["vms-bookmarks", cameraId] });
  const invalidateLocks = () => qc.invalidateQueries({ queryKey: ["vms-evidence", cameraId] });

  const deleteBookmark = async (b) => {
    try {
      await vms.bookmarks.remove(b.id);
      if (activeBookmark?.id === b.id) setActiveBookmark(null);
      toast.success("Bookmark deleted");
      invalidateBookmarks();
    } catch (e) {
      toast.error(apiError(e, "Delete failed"));
    }
  };
  const releaseLock = async (l) => {
    try {
      await vms.evidence.release(l.id);
      toast.success("Evidence hold released");
      invalidateLocks();
    } catch (e) {
      toast.error(apiError(e, "Release failed"));
    }
  };
  const deleteLock = async (l) => {
    try {
      await vms.evidence.remove(l.id);
      toast.success("Evidence hold deleted");
      invalidateLocks();
    } catch (e) {
      toast.error(apiError(e, "Delete failed"));
    }
  };

  // First recorded timestamp in the window → a sensible default playhead.
  const firstCoverageMs = useMemo(() => {
    let min = null;
    for (const c of coverage) {
      const s = c?.start ? new Date(c.start).getTime() : null;
      if (s != null && (min == null || s < min)) min = s;
    }
    return min;
  }, [coverage]);

  // ── Playback session ────────────────────────────────────────────────────
  const { hlsUrl, loading, error, load, clear } = usePlaybackSession(cameraId, {
    profile,
    sourceFn,
    enabled: !!cameraId,
  });

  // Load a session for the current window whenever the window changes.
  useEffect(() => {
    if (!cameraId) return;
    setVideoError(false);
    load({ from: iso(windowStart), to: iso(windowEnd) });
    return () => clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, windowStart, windowEnd, !!sourceFn]);

  // Default the playhead to the first coverage block once we know it.
  useEffect(() => {
    if (controlled) return;
    if (current == null && firstCoverageMs != null) setCurrent(firstCoverageMs);
  }, [controlled, current, firstCoverageMs]);

  // ── HLS attach ───────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hlsUrl) return undefined;
    let disposed = false;
    setVideoError(false);

    const cleanup = () => {
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {}
        hlsRef.current = null;
      }
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {}
    };

    const attach = async () => {
      cleanup();
      // Native HLS (Safari).
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
        return;
      }
      try {
        const Hls = (await import("hls.js")).default;
        if (disposed) return;
        if (!Hls.isSupported()) {
          video.src = hlsUrl; // last-ditch
          return;
        }
        const hls = new Hls({
          enableWorker: false,
          backBufferLength: 90,
          manifestLoadingMaxRetry: 3,
          manifestLoadingRetryDelay: 600,
          fragLoadingMaxRetry: 6,
        });
        hlsRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (disposed || !data?.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try {
              hls.startLoad();
            } catch {}
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try {
              hls.recoverMediaError();
            } catch {
              setVideoError(true);
            }
          } else {
            setVideoError(true);
          }
        });
      } catch {
        if (!disposed) setVideoError(true);
      }
    };

    attach();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [hlsUrl]);

  // ── Transport → <video> ──────────────────────────────────────────────────
  const isPlaying = controlled ? playing : localPlaying;
  const rate = controlled ? speed : localSpeed;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
  }, [rate, hlsUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) v.play().catch(() => {});
    else v.pause();
  }, [isPlaying, hlsUrl]);

  // Map an absolute epoch-ms target to a video offset within the window and seek.
  const seekToMs = useCallback(
    (ms) => {
      const v = videoRef.current;
      if (!v) return;
      const offset = (ms - windowStart) / 1000;
      if (offset < 0) return;
      if (Number.isFinite(v.duration) && offset > v.duration) return;
      seekingRef.current = true;
      try {
        v.currentTime = offset;
      } catch {}
      setTimeout(() => {
        seekingRef.current = false;
      }, 120);
      setCurrent(ms);
    },
    [windowStart],
  );

  // Controlled: follow the parent's shared seek target.
  useEffect(() => {
    if (!controlled || seekMs == null) return;
    seekToMs(seekMs);
  }, [controlled, seekMs, seekToMs]);

  // Deep-link seek (jump-to-recording): once the HLS session for the target day
  // is attached, seek to the requested instant. Fires once per initialSeek value.
  const seekedInitialRef = useRef(false);
  useEffect(() => {
    if (controlled || !initialSeek || seekedInitialRef.current) return;
    if (!hlsUrl) return; // wait for the session/manifest
    const ms = new Date(initialSeek).getTime();
    if (Number.isNaN(ms) || ms < windowStart || ms > windowEnd) return;
    seekedInitialRef.current = true;
    // The <video> needs metadata before currentTime sticks; retry briefly.
    const v = videoRef.current;
    const trySeek = () => {
      if (!videoRef.current) return;
      if (Number.isFinite(videoRef.current.duration)) {
        seekToMs(ms);
      } else {
        setCurrent(ms);
        setTimeout(trySeek, 250);
      }
    };
    if (v) v.addEventListener("loadedmetadata", trySeek, { once: true });
    trySeek();
  }, [controlled, initialSeek, hlsUrl, windowStart, windowEnd, seekToMs]);

  // Track the playhead from the video, mapping offset → absolute time.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onTime = () => {
      if (seekingRef.current) return;
      const ms = windowStart + v.currentTime * 1000;
      setCurrent(ms);
      onClock?.(ms);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [windowStart, onClock]);

  // ── Standalone controls ──────────────────────────────────────────────────
  const onScrubSeek = (ms) => {
    if (!localPlaying) setCurrent(ms);
    seekToMs(ms);
  };

  const frameStep = (dir) => {
    const v = videoRef.current;
    if (!v) return;
    setLocalPlaying(false);
    v.pause();
    const fps = 25; // unknown fps — assume 25 for recorded fmp4
    const next = Math.max(0, v.currentTime + dir / fps);
    v.currentTime = next;
    setCurrent(windowStart + next * 1000);
  };

  const snapshot = () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 480;
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${cameraName || cameraId || "snapshot"}-${readout(current).replace(/:/g, "-")}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, "image/png");
    } catch {
      /* not decodable yet */
    }
  };

  const noRecordings = !controlled && !timelineQ.isLoading && coverage.length === 0;

  // ── Slaved (controlled) cell — just the video ────────────────────────────
  if (controlled) {
    return (
      <div className={`relative overflow-hidden rounded-lg bg-black ${className}`}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} className="h-full w-full object-contain" playsInline muted />
        {(loading || (!hlsUrl && !error)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white/80">
            <Icon icon="svg-spinners:180-ring" className="text-xl" />
          </div>
        )}
        {(error || videoError) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 px-2 text-center text-[11px] text-red-300">
            <Icon icon="heroicons-outline:exclamation-triangle" className="text-xl" />
            No footage
          </div>
        )}
      </div>
    );
  }

  // ── Standalone player ────────────────────────────────────────────────────
  return (
    <div className={`overflow-hidden rounded-xl border border-card-border bg-card ${className}`}>
      {/* Video area */}
      <div className="relative aspect-video w-full bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} className="h-full w-full object-contain" playsInline muted />

        {/* Time overlay */}
        {hlsUrl && !videoError && (
          <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
            {new Date(current ?? windowStart).toLocaleString(undefined, { hour12: false })}
          </div>
        )}
        {rate !== 1 && hlsUrl && (
          <span className="pointer-events-none absolute right-3 top-3 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
            {rate}×
          </span>
        )}

        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60 text-white/85">
            <Icon icon="svg-spinners:180-ring" className="text-2xl" />
            <p className="text-xs">Loading recorded video…</p>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/85 px-4 text-center">
            <Icon icon="heroicons-outline:exclamation-triangle" className="text-3xl text-red-400" />
            <p className="max-w-sm text-xs text-red-200">{error}</p>
          </div>
        )}
        {noRecordings && !loading && !error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/40 text-center text-white/80">
            <Icon icon="heroicons-outline:film" className="text-3xl opacity-60" />
            <p className="text-sm">No recordings on {day}</p>
            <p className="text-xs text-white/60">Pick another date or camera.</p>
          </div>
        )}
      </div>

      {/* Transport */}
      <div className="flex flex-wrap items-center gap-2 border-t border-card-border px-3 py-2.5">
        <CtrlBtn icon="heroicons-solid:backward" title="Frame back" onClick={() => frameStep(-1)} disabled={!hlsUrl} />
        <CtrlBtn
          icon={localPlaying ? "heroicons-solid:pause" : "heroicons-solid:play"}
          title={localPlaying ? "Pause" : "Play"}
          onClick={() => setLocalPlaying((p) => !p)}
          disabled={!hlsUrl}
          primary
        />
        <CtrlBtn icon="heroicons-solid:forward" title="Frame forward" onClick={() => frameStep(1)} disabled={!hlsUrl} />

        <div className="mx-1 h-5 w-px bg-card-border" />

        <span className="font-mono text-sm tabular-nums text-foreground">{readout(current)}</span>

        <div className="ml-auto flex items-center gap-2">
          <div className="w-20">
            <Select
              value={String(localSpeed)}
              onChange={(e) => setLocalSpeed(parseFloat(e.target.value))}
              options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
              className="!h-8 !py-1"
            />
          </div>
          <input
            type="date"
            value={day}
            max={todayStr()}
            onChange={(e) => {
              setDay(e.target.value);
              setCurrent(null);
              setLocalPlaying(false);
            }}
            className="h-8 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted"
          />
          <CtrlBtn icon="heroicons-outline:camera" title="Snapshot" onClick={snapshot} disabled={!hlsUrl} plain />
          <CtrlBtn
            icon="heroicons-outline:bookmark"
            title="Bookmark this moment"
            onClick={() => {
              setActiveBookmark(null);
              setEditBookmark(null);
              setBookmarkSeed({ start: iso(current ?? windowStart) });
            }}
            plain
          />
          {canSearch && (
            <CtrlBtn
              icon="heroicons-outline:magnifying-glass-circle"
              title="Smart motion search"
              onClick={() => setMotionSearchOpen(true)}
              plain
            />
          )}
          {canLock && (
            <CtrlBtn
              icon="heroicons-outline:lock-closed"
              title="Lock this window as evidence"
              onClick={() => setLockSeed({ start: iso(windowStart), end: iso(windowEnd) })}
              plain
            />
          )}
          {onExportRange && (
            <CtrlBtn
              icon="heroicons-outline:scissors"
              title="Export this window"
              onClick={() => onExportRange({ from: iso(windowStart), to: iso(windowEnd) })}
              plain
            />
          )}
        </div>
      </div>

      {/* Scrub bar */}
      <div className="relative px-3 pb-3 pt-1">
        <ScrubBar
          coverage={coverage}
          markers={markers}
          bookmarks={bookmarks}
          locks={locks}
          motionHits={motionHits}
          windowStart={windowStart}
          windowEnd={windowEnd}
          current={current}
          onSeek={onScrubSeek}
          onBookmarkClick={(bm) => setActiveBookmark(bm)}
          disabled={!hlsUrl && !timelineQ.isLoading && coverage.length === 0}
        />
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted">
          <span>{new Date(windowStart).toLocaleDateString()}</span>
          <span>
            {timelineQ.isLoading
              ? "Loading coverage…"
              : coverage.length
                ? `${coverage.length} span${coverage.length === 1 ? "" : "s"} recorded`
                : "No coverage"}
          </span>
        </div>

        {/* G4 — motion-search hits plotted on the timeline (fuchsia). */}
        {motionHits.length > 0 && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-[11px]">
            <span className="inline-block h-2 w-3 rounded-sm bg-fuchsia-500/60" />
            <span className="text-foreground">
              {motionHits.length} motion hit{motionHits.length === 1 ? "" : "s"} on the timeline
            </span>
            <button
              type="button"
              onClick={() => setMotionSearchOpen(true)}
              className="ml-auto text-muted hover:text-foreground"
            >
              Refine
            </button>
            <button
              type="button"
              onClick={() => setMotionHits([])}
              className="text-muted hover:text-foreground"
            >
              Clear
            </button>
          </div>
        )}

        {/* Bookmark popover — appears after clicking a flag on the scrub bar */}
        {activeBookmark && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
            <Icon icon="heroicons-solid:bookmark" className="mt-0.5 shrink-0 text-sky-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{activeBookmark.title}</p>
              <p className="text-[11px] text-muted">
                {readout(new Date(activeBookmark.start_ts).getTime())}
                {activeBookmark.end_ts
                  ? ` – ${readout(new Date(activeBookmark.end_ts).getTime())}`
                  : ""}
              </p>
              {activeBookmark.note && <p className="mt-0.5 text-[11px] text-muted">{activeBookmark.note}</p>}
              {activeBookmark.tags?.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {activeBookmark.tags.map((t) => (
                    <span key={t} className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <CtrlBtn
                icon="heroicons-outline:pencil-square"
                title="Edit bookmark"
                onClick={() => {
                  setBookmarkSeed(null);
                  setEditBookmark(activeBookmark);
                }}
                plain
              />
              <CtrlBtn
                icon="heroicons-outline:trash"
                title="Delete bookmark"
                onClick={() => deleteBookmark(activeBookmark)}
                plain
              />
              <CtrlBtn
                icon="heroicons-outline:x-mark"
                title="Close"
                onClick={() => setActiveBookmark(null)}
                plain
              />
            </div>
          </div>
        )}
      </div>

      {/* Bookmarks + evidence-holds side rail */}
      <div className="border-t border-card-border p-3">
        <BookmarksPanel
          bookmarks={bookmarks}
          locks={locks}
          loading={bookmarksQ.isLoading || locksQ.isLoading}
          canLock={canLock}
          onSeek={(ms) => onScrubSeek(ms)}
          onEditBookmark={(b) => {
            setActiveBookmark(null);
            setBookmarkSeed(null);
            setEditBookmark(b);
          }}
          onDeleteBookmark={deleteBookmark}
          onReleaseLock={releaseLock}
          onDeleteLock={deleteLock}
        />
      </div>

      {/* Modals */}
      <BookmarkModal
        open={!!bookmarkSeed || !!editBookmark}
        onClose={() => {
          setBookmarkSeed(null);
          setEditBookmark(null);
        }}
        cameraId={cameraId}
        cameraName={cameraName}
        seed={bookmarkSeed}
        bookmark={editBookmark}
        onSaved={() => invalidateBookmarks()}
      />
      <EvidenceLockModal
        open={!!lockSeed}
        onClose={() => setLockSeed(null)}
        cameraId={cameraId}
        cameraName={cameraName}
        seed={lockSeed}
        onSaved={() => invalidateLocks()}
      />
      {canSearch && (
        <MotionSearchModal
          open={motionSearchOpen}
          onClose={() => setMotionSearchOpen(false)}
          cameraId={cameraId}
          cameraName={cameraName}
          seedFrom={iso(windowStart)}
          seedTo={iso(current ?? windowEnd)}
          onResults={({ hits }) => setMotionHits(hits || [])}
          onSeekHit={(isoTs) => {
            const ms = new Date(isoTs).getTime();
            if (!Number.isNaN(ms)) onScrubSeek(ms);
            setMotionSearchOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CtrlBtn({ icon, title, onClick, disabled, primary, plain }) {
  const base =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-40 disabled:pointer-events-none";
  const skin = primary
    ? "bg-foreground text-background hover:opacity-90"
    : plain
      ? "border border-card-border text-muted hover:bg-hover hover:text-foreground"
      : "text-muted hover:bg-hover hover:text-foreground";
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={`${base} ${skin}`}>
      <Icon icon={icon} className="text-base" />
    </button>
  );
}
