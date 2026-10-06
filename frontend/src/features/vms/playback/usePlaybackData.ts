"use client";

// What the Playback workspace reads and does against the recorders, kept out of the
// component so it stays a layout: coverage, events and bookmarks per camera over the
// visible window, the calendar's marks, and the investigation actions (bookmark,
// protect, export the grid, motion-search seed). SCRUM-305 / SCRUM-307.
import { useMemo, useState } from "react";
import { keepPreviousData, skipToken, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { WallClock } from "../hooks/useWallPlayback";
import type { MotionSearchResults } from "../components/playbackTypes";
import type { InvBookmark, InvEvent, InvExport, InvMotion } from "./PlaybackInvestigation";
import { clockText, localDay, monthRange, queryWindow, spansFromRanges, type Span, type Win } from "./playbackModel";
import type { PlaybackCam, Selection } from "./usePlaybackWorkspace";

const iso = (ms: number) => new Date(ms).toISOString();
const operatorTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const sortNewestFirst = <T extends { at: number }>(list: T[]): T[] => {
  list.sort((a, b) => b.at - a.at);
  return list;
};

const windowQuery = { staleTime: 30_000, retry: false, refetchOnWindowFocus: false, placeholderData: keepPreviousData };

/** Coverage, events and bookmarks for every camera in the grid, over the window. */
export function useGridData(cams: PlaybackCam[], win: Win) {
  const q = queryWindow(win);
  const range = { from: iso(q.fromMs), to: iso(q.toMs) };

  const coverageQs = useQueries({
    queries: cams.map((c) => ({
      queryKey: ["vms-pb2-coverage", c.key, q.fromMs, q.toMs],
      queryFn: () => vms.federation.timeline(c.nodeId, c.realId, range),
      ...windowQuery,
    })),
  });
  const eventQs = useQueries({
    queries: cams.map((c) => ({
      queryKey: ["vms-pb2-events", c.realId, q.fromMs, q.toMs],
      queryFn: () => vms.events.list({ camera_id: c.realId, ...range, limit: 500 }),
      ...windowQuery,
    })),
  });
  const bookmarkQs = useQueries({
    queries: cams.map((c) => ({
      queryKey: ["vms-pb2-bookmarks", c.key, q.fromMs, q.toMs],
      queryFn: () => vms.federation.bookmarks.list(c.nodeId, c.realId, range),
      ...windowQuery,
    })),
  });

  const spansByKey = useMemo(() => {
    const m = new Map<string, Span[]>();
    cams.forEach((c, i) => m.set(c.key, spansFromRanges(coverageQs[i]?.data?.ranges)));
    return m;
  }, [cams, coverageQs]);

  const events = useMemo<InvEvent[]>(() => {
    const out: InvEvent[] = [];
    cams.forEach((c, i) => {
      for (const e of eventQs[i]?.data?.items ?? []) {
        // When it HAPPENED, not when this service heard about it.
        const at = new Date(e.occurred_at || e.created_at || "").getTime();
        if (Number.isFinite(at)) out.push({ key: `${c.key}:${e.id}`, camKey: c.key, camName: c.name, at, type: e.event_type });
      }
    });
    return sortNewestFirst(out);
  }, [cams, eventQs]);

  const bookmarks = useMemo<InvBookmark[]>(() => {
    const out: InvBookmark[] = [];
    cams.forEach((c, i) => {
      for (const b of bookmarkQs[i]?.data?.items ?? []) {
        const at = new Date(b.at).getTime();
        if (Number.isFinite(at)) {
          out.push({ id: b.id, camKey: c.key, camName: c.name, nodeId: c.nodeId, at, label: b.label, note: b.note });
        }
      }
    });
    return sortNewestFirst(out);
  }, [cams, bookmarkQs]);

  const eventsByKey = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const c of cams) m.set(c.key, []);
    for (const e of events) m.get(e.camKey)?.push(e.at);
    return m;
  }, [cams, events]);

  const coverageFailed = useMemo(
    () => new Set(cams.filter((_, i) => coverageQs[i]?.error).map((c) => c.key)),
    [cams, coverageQs],
  );

  return {
    spansByKey,
    eventsByKey,
    events,
    bookmarks,
    bookmarksFailed: bookmarkQs.some((x) => x.error),
    coverageFailed,
  };
}

/** The calendar's marks for one camera and month, from its recorder's index. */
export function useRecordingDays(cam: PlaybackCam | null, view: { year: number; month: number }) {
  const month = monthRange(view.year, view.month);
  const daysQ = useQuery({
    queryKey: ["vms-pb2-days", cam?.key, month.from],
    queryFn: cam
      ? () => vms.federation.recordingDays(cam.nodeId, cam.realId, { ...month, tz: operatorTz() })
      : skipToken,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => {
    const footageDays = new Set<number>();
    const eventDays = new Set<number>();
    for (const d of daysQ.data?.days ?? []) {
      const n = Number(d.date.slice(8, 10));
      if (d.recorded) footageDays.add(n);
      if (d.event) eventDays.add(n);
    }
    return { footageDays, eventDays, failed: !!daysQ.error };
  }, [daysQ.data, daysQ.error]);
}

interface InvestigationArgs {
  cams: PlaybackCam[];
  activeCam: PlaybackCam | null;
  clock: WallClock;
  sel: Selection;
  hasSel: boolean;
  win: Win;
}

const MOTION_MAX_MS = 6 * 3_600_000;

/** Bookmark, protect, export-the-grid and the motion-search seed (SCRUM-307). */
export function useInvestigation({ cams, activeCam, clock, sel, hasSel, win }: InvestigationArgs) {
  const qc = useQueryClient();
  const [motion, setMotion] = useState<(InvMotion & { camKey: string }) | null>(null);
  const [raised, setRaised] = useState<Omit<InvExport, "status" | "error">[]>([]);

  const selIso = hasSel && sel.inMs != null && sel.outMs != null ? { from: iso(sel.inMs), to: iso(sel.outMs) } : null;
  const selectionText = hasSel ? `${clockText(sel.inMs)}–${clockText(sel.outMs)}` : null;

  const addBookmark = async (label: string, note: string): Promise<boolean> => {
    const at = clock.get();
    if (!activeCam || at == null) return false;
    try {
      await vms.federation.bookmarks.create(activeCam.nodeId, activeCam.realId, {
        at: iso(at),
        label,
        ...(note ? { note } : {}),
      });
      toast.success(`Bookmarked ${activeCam.name} at ${clockText(at)}`);
      void qc.invalidateQueries({ queryKey: ["vms-pb2-bookmarks", activeCam.key] });
      return true;
    } catch (e) {
      toast.error(apiError(e, "The recorder did not save the bookmark"));
      return false;
    }
  };

  const deleteBookmark = async (b: InvBookmark) => {
    try {
      await vms.federation.bookmarks.remove(b.nodeId, b.id);
      void qc.invalidateQueries({ queryKey: ["vms-pb2-bookmarks", b.camKey] });
    } catch (e) {
      toast.error(apiError(e, "The recorder did not delete the bookmark"));
    }
  };

  // Protect = an evidence hold on the RECORDER for the marked range, on every camera
  // in the grid: retention will not delete it until it is released there.
  const protectSel = async () => {
    if (!selIso || !cams.length) return;
    const results = await Promise.allSettled(
      cams.map((c) =>
        vms.federation.actions.holdCreate(c.nodeId, c.realId, selIso.from, selIso.to, "Protected from VMS playback"),
      ),
    );
    const failed = cams.filter((_, i) => results[i].status === "rejected").map((c) => c.name);
    if (failed.length) toast.error(`Not protected on ${failed.join(", ")}: the recorder refused or did not answer`);
    else toast.success(`Protected ${selectionText} on ${cams.length} camera${cams.length === 1 ? "" : "s"}`);
  };

  // Export every camera in the grid: one job per camera, cut and signed by the
  // recorder that holds its footage, followed in the Exports tab.
  const exportAll = async () => {
    if (!selIso) return;
    const jobs: Omit<InvExport, "status" | "error">[] = [];
    for (const c of cams) {
      try {
        const job = await vms.federation.actions.createExport(c.nodeId, c.realId, selIso.from, selIso.to);
        jobs.push({ id: job.id, nodeId: c.nodeId, camName: c.name, from: selIso.from, to: selIso.to });
      } catch (e) {
        toast.error(`${c.name}: ${apiError(e, "export refused")}`);
      }
    }
    if (jobs.length) setRaised((x) => [...jobs, ...x]);
  };

  const exportQs = useQueries({
    queries: raised.map((x) => ({
      queryKey: ["vms-pb2-export", x.nodeId, x.id],
      queryFn: () => vms.federation.actions.getExport(x.nodeId, x.id),
      retry: false,
      refetchInterval: (q: { state: { data?: { status?: string } } }) => {
        const st = q.state.data?.status;
        return st === "done" || st === "failed" ? false : 2_000;
      },
    })),
  });
  const exportsList: InvExport[] = raised.map((x, i) => ({
    ...x,
    status: exportQs[i]?.data?.status ?? "pending",
    error: exportQs[i]?.data?.error ?? null,
  }));

  const downloadExport = async (x: InvExport) => {
    try {
      const blob = await vms.federation.actions.downloadExportBlob(x.nodeId, x.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const fromMs = new Date(x.from).getTime();
      a.href = url;
      a.download = `${x.camName}-${localDay(fromMs)}_${clockText(fromMs).replaceAll(":", "-")}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "The download failed"));
    }
  };

  // Motion search runs on the RECORDER over the marked range, else the visible
  // window, capped at the recorder's 6 h.
  const motionTo = selIso ? (sel.outMs ?? win.toMs) : win.toMs;
  const motionFrom = selIso ? (sel.inMs ?? win.fromMs) : win.fromMs;
  const motionSeed = { from: iso(Math.max(motionFrom, motionTo - MOTION_MAX_MS)), to: iso(motionTo) };

  return {
    selIso,
    selectionText,
    addBookmark,
    deleteBookmark,
    protectSel,
    exportAll,
    exportsList,
    downloadExport,
    motion,
    setMotion,
    motionSeed,
  };
}

/** A motion search's answer as the workspace keeps it, or null when it found nothing
 *  and had nothing to say. */
export function motionFrom(cam: PlaybackCam, r: MotionSearchResults): (InvMotion & { camKey: string }) | null {
  if (!r.hits.length && !r.note) return null;
  return {
    camKey: cam.key,
    camName: cam.name,
    hits: r.hits.map((h) => ({ s: new Date(h.start).getTime(), e: new Date(h.end).getTime(), score: h.score })),
    note: r.note,
  };
}
