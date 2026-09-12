"use client";

// MotionSearchModal (G4) — Smart / forensic motion search over recorded footage.
//
// The investigator draws a region over a REFERENCE FRAME (a snapshot of the camera),
// picks a time window and sensitivity, and the RECORDER searches its own footage.
// It has to be the recorder: the search decodes the segment files, and those live on
// its disk. Hit intervals come back for the caller to plot on the ScrubBar.
//
// The region is stored NORMALIZED (0..1): {x,y} = top-left, {w,h} = size relative to
// the frame. No region = the whole frame.
//
// ONE region, not a list. The recorder's search takes a single rectangle, and the
// modal used to collect several and send them all to the VMS's own searcher — so the
// two disagreed about what was even being asked. Drawing a new rectangle replaces
// the previous one rather than adding to it.
//
// SYNCHRONOUS. There is no job to poll: the recorder bounds the search itself (span,
// frame budget, deadline) and answers with what it managed to examine. That is a
// better shape than a queue, and it is why `complete`/`notes` below are load-bearing
// — a bounded search that gave up must never present an empty hit list as "the
// footage is clear".
//
// The response's `method` disclosure is rendered verbatim, every time. This is
// pixel-difference over sampled frames, NOT object detection, and a hit list is
// exactly the sort of output somebody reads as "three intruders" if nothing says
// otherwise.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { vms } from "../api";
import type { FederatedMotionSearch, MotionHit, MotionRegion } from "../types";
import type { MotionSearchResults } from "./playbackTypes";

// ISO ↔ the value a datetime-local input wants (local wall-clock).
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour12: false });

// ── Drawing a region without a mouse ────────────────────────────────────────
// A step is 5% of the frame and the smallest side is 5% too, which is above the
// 2% threshold a mouse drag has to clear — so a region built from the keyboard
// can never be one the commit path throws away as an accidental click.
const KEY_STEP = 0.05;
const MIN_SIDE = 0.05;
/** Where the first key press puts a region: centred, half the frame, so it is
 *  visible and has room to move in every direction. */
const SEED_REGION: MotionRegion = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

/** What a key press does to the region being drawn, or null for a key the draw
 *  surface does not claim — so Tab still leaves it and shortcuts above still fire.
 *
 *  `region` is the draft under the cursor (null = nothing drawn yet). Arrows move
 *  it, Shift+arrows grow or shrink it from its top-left corner, Enter/Space seeds
 *  one and then keeps it, Escape throws the draft away.
 *
 *  Escape with NOTHING drawn is not claimed, and that is the whole of it: this
 *  modal closes on Escape from a document-level listener, so the first press has
 *  to mean "abandon the box I am drawing" and the second "close the dialog". A
 *  press that did both would close the dialog whatever the operator meant.
 *
 *  Out here rather than inside the handler because this is the whole of drawing a
 *  region from the keyboard, and clamping a rectangle to the frame is exactly the
 *  sort of arithmetic worth pinning down without a DOM. */
export function regionKeyAction(
  key: string,
  { shiftKey = false, region = null }: { shiftKey?: boolean; region?: MotionRegion | null } = {},
): { kind: "draft"; region: MotionRegion } | { kind: "commit" } | { kind: "discard" } | null {
  if (key === "Escape") return region ? { kind: "discard" } : null;
  if (key === "Enter" || key === " ")
    return region ? { kind: "commit" } : { kind: "draft", region: SEED_REGION };

  const DIRECTIONS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const dir = DIRECTIONS[key];
  if (!dir) return null;
  // An arrow with nothing drawn yet seeds the region instead of doing nothing:
  // a focused surface that swallows arrows silently is the trap this avoids.
  if (!region) return { kind: "draft", region: SEED_REGION };

  const [dx, dy] = dir;
  if (shiftKey) {
    // A side may not shrink below MIN_SIDE nor grow past the frame's edge.
    const side = (v: number, origin: number) => Math.max(MIN_SIDE, Math.min(1 - origin, v));
    return {
      kind: "draft",
      region: {
        ...region,
        w: side(region.w + dx * KEY_STEP, region.x),
        h: side(region.h + dy * KEY_STEP, region.y),
      },
    };
  }
  // Moving stops at the edges rather than pushing the region off the frame.
  const origin = (v: number, extent: number) => Math.max(0, Math.min(1 - extent, v));
  return {
    kind: "draft",
    region: {
      ...region,
      x: origin(region.x + dx * KEY_STEP, region.w),
      y: origin(region.y + dy * KEY_STEP, region.h),
    },
  };
}

export interface MotionSearchModalProps {
  open: boolean;
  onClose?: () => void;
  /** The recorder that holds the footage and runs the search. */
  nodeId: string;
  /** The camera's id ON that recorder. */
  cameraId: string;
  cameraName?: string | null;
  /** Seed window (ISO) — defaults to the loaded playback window. */
  seedFrom?: string | null;
  seedTo?: string | null;
  /** Called on a successful `done` so the parent can plot the intervals on the
   *  timeline. Also fires with hits:[] to clear. */
  onResults?: (results: MotionSearchResults) => void;
  /** Click a hit → seek playback there. */
  onSeekHit?: (iso: string) => void;
}

export default function MotionSearchModal({
  open,
  onClose,
  nodeId,
  cameraId,
  cameraName,
  seedFrom = null,
  seedTo = null,
  onResults,
  onSeekHit,
}: MotionSearchModalProps) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // 0..1 in the UI, 1..100 on the wire — the recorder's scale. Converted at the
  // call, not stored converted, so the slider keeps its own vocabulary.
  const [sensitivity, setSensitivity] = useState(0.5);
  // Frames per second in the UI; the recorder takes an INTERVAL in seconds. Same
  // idea, reciprocal — converted at the call.
  const [sampleFps, setSampleFps] = useState(4);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reference frame (camera snapshot as a blob object-URL).
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState(false);
  const [frameLoading, setFrameLoading] = useState(false);

  // Drawn regions — normalized rects { x, y, w, h }.
  const [regions, setRegions] = useState<MotionRegion[]>([]);
  const [draft, setDraft] = useState<MotionRegion | null>(null); // in-progress rect while dragging (normalized)

  // Search lifecycle.
  const [running, setRunning] = useState(false);
  const [hits, setHits] = useState<MotionHit[] | null>(null); // null = not run yet; [] = ran, no hits
  // The recorder's own account of the search: what it examined, what it could not,
  // and what the method does and does not mean.
  const [result, setResult] = useState<FederatedMotionSearch | null>(null);
  const [jobError, setJobError] = useState("");

  const drawRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);

  // ── Seed window + fetch a reference frame when opened ────────────────────
  useEffect(() => {
    if (!open) return;
    setFrom(toLocalInput(seedFrom) || toLocalInput(new Date(Date.now() - 3_600_000).toISOString()));
    setTo(toLocalInput(seedTo) || toLocalInput(new Date().toISOString()));
    setRegions([]);
    setDraft(null);
    setHits(null);
    setResult(null);
    setJobError("");
    setRunning(false);

    let objectUrl: string | null = null;
    let cancelled = false;
    setFrameLoading(true);
    setFrameError(false);
    setFrameUrl(null);
    api
      .get<Blob>(vms.federation.snapshotUrl(nodeId, cameraId), { responseType: "blob" })
      .then((r) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(r.data);
        setFrameUrl(objectUrl);
      })
      .catch(() => !cancelled && setFrameError(true))
      .finally(() => !cancelled && setFrameLoading(false));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
     
  }, [open, nodeId, cameraId, seedFrom, seedTo]);

  // ── Draw layer — drag to add a normalized rect ───────────────────────────
  const rectFromEvent = (e: MouseEvent<HTMLButtonElement>) => {
    const box = drawRef.current?.getBoundingClientRect();
    if (!box?.width || !box?.height) return null;
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  const onDrawDown = (e: MouseEvent<HTMLButtonElement>) => {
    if (running) return;
    const p = rectFromEvent(e);
    if (!p) return;
    dragRef.current = { startX: p.x, startY: p.y };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    e.preventDefault();
  };

  const onDrawMove = (e: MouseEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    const p = rectFromEvent(e);
    if (!p) return;
    const { startX, startY } = dragRef.current;
    setDraft({
      x: Math.min(startX, p.x),
      y: Math.min(startY, p.y),
      w: Math.abs(p.x - startX),
      h: Math.abs(p.y - startY),
    });
  };

  const onDrawUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraft((d) => {
      // Ignore accidental micro-drags (a click).
      if (d && d.w > 0.02 && d.h > 0.02) {
        setRegions((prev) => [...prev, { x: d.x, y: d.y, w: d.w, h: d.h }]);
      }
      return null;
    });
  };

  const removeRegion = (idx: number) => setRegions((prev) => prev.filter((_, i) => i !== idx));
  const clearRegions = () => setRegions([]);

  const onDrawKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (running) return;
    const action = regionKeyAction(e.key, { shiftKey: e.shiftKey, region: draft });
    if (!action) return; // not ours — Tab, shortcuts and typing carry on
    e.preventDefault();
    if (action.kind === "draft") {
      setDraft(action.region);
    } else if (action.kind === "commit") {
      if (draft) setRegions((prev) => [...prev, draft]);
      setDraft(null);
    } else {
      // Stopped here, so the dialog's own Escape listener does not also fire and
      // close it. Abandoning a half-drawn box and abandoning the search are two
      // different intentions, and Escape has to be able to mean the first.
      e.stopPropagation();
      setDraft(null);
    }
  };

  // ── Run the search ────────────────────────────────────────────────────────
  const fromIso = fromLocalInput(from);
  const toIso = fromLocalInput(to);
  const windowValid = !!fromIso && !!toIso && new Date(toIso) > new Date(fromIso);
  const canRun = !!cameraId && windowValid && !running;

  const runSearch = async () => {
    if (!canRun || !fromIso || !toIso) return; // `canRun` already implies the window; this narrows it
    setRunning(true);
    setHits(null);
    setResult(null);
    setJobError("");
    onResults?.({ hits: [], jobId: null, note: "" }); // clear any prior plot

    try {
      const res = await vms.federation.motionSearch(nodeId, cameraId, {
        from: fromIso,
        to: toIso,
        // One rectangle, or none at all for the whole frame. The recorder takes a
        // single region; sending a list would be sending it something it cannot read.
        region: regions[0],
        // 0..1 slider → the recorder's 1..100. Rounded and clamped so the ends of
        // the slider land on real values rather than 0 or 101.
        sensitivity: Math.min(100, Math.max(1, Math.round(sensitivity * 100))),
        // fps → seconds between samples.
        sample_interval_sec: sampleFps > 0 ? 1 / sampleFps : 1,
      });
      setResult(res);
      const found = Array.isArray(res.hits) ? res.hits : [];
      setHits(found);
      // `notes` is the recorder saying which of its bounds bit. It rides through to
      // the caller as the plot's note so an incomplete search cannot be read off the
      // timeline as a complete one.
      const note = (res.notes || []).join(" ");
      onResults?.({ hits: found, jobId: null, note });
      if (res.complete === false) {
        toast.warning(
          found.length
            ? `${found.length} hit${found.length === 1 ? "" : "s"} — the search did not cover the whole window`
            : "The search did not cover the whole window; nothing found in the part it examined",
        );
      } else {
        toast.success(
          found.length
            ? `${found.length} motion hit${found.length === 1 ? "" : "s"} found`
            : "No motion in the selected region",
        );
      }
    } catch (e) {
      setJobError(apiError(e, "Motion search failed"));
      setHits([]);
      toast.error(apiError(e, "Motion search failed"));
    } finally {
      setRunning(false);
    }
  };

  const regionSummary = useMemo(
    () => (regions.length ? `${regions.length} region${regions.length === 1 ? "" : "s"}` : "Whole frame"),
    [regions.length],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Smart motion search"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {running ? (
            /* No Cancel. The recorder runs the search in one bounded call — there is
               no job to cancel, and a button that only stopped this browser waiting
               would suggest the recorder had stopped too. */
            <Button variant="primary" disabled>
              <Icon icon="svg-spinners:180-ring" className="text-base" /> Searching…
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="heroicons-outline:magnifying-glass"
              disabled={!canRun}
              onClick={runSearch}
            >
              Search
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.08)]/40 px-3 py-2 text-sm">
          <span className="text-[#aec2e8]">Camera</span>{" "}
          <span className="font-medium text-[#f2f6ff]">{cameraName || cameraId}</span>
        </div>

        {/* Reference frame + draw layer */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">
              Draw region(s) to search — {regionSummary}
            </span>
            {regions.length > 0 && (
              <button
                type="button"
                onClick={clearRegions}
                disabled={running}
                className="text-[11px] text-[#aec2e8] hover:text-[#67e8f9] disabled:opacity-40"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="relative aspect-video w-full select-none overflow-hidden rounded-lg border border-[rgba(150,180,245,.22)] bg-black">
            {frameLoading ? (
              <div className="absolute inset-0 flex items-center justify-center text-white/70">
                <Icon icon="svg-spinners:180-ring" className="text-2xl" />
              </div>
            ) : frameError || !frameUrl ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs text-white/60">
                <Icon icon="heroicons-outline:photo" className="text-2xl opacity-60" />
                Reference frame unavailable — draw over the black frame (regions still apply).
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={frameUrl}
                alt="reference frame"
                draggable={false}
                className="pointer-events-none h-full w-full object-contain"
              />
            )}

            {/* The drawing surface is a real BUTTON covering the frame, not the
                frame's container with mouse handlers hung on it. A region drawn
                only by dragging is a region an operator without a mouse cannot
                draw at all, and the whole forensic search is scoped by it. The
                button takes focus natively, and `onDrawKeyDown` is the same
                editing gesture through the keyboard — see `regionKeyAction`. */}
            <button
              ref={drawRef}
              type="button"
              disabled={running}
              aria-label="Draw the region to search. Enter places a region, the arrow keys move it, Shift with an arrow key resizes it, Enter keeps it and Escape removes it."
              onMouseDown={onDrawDown}
              onMouseMove={onDrawMove}
              onMouseUp={onDrawUp}
              onMouseLeave={onDrawUp}
              onKeyDown={onDrawKeyDown}
              className={`absolute inset-0 z-1 rounded-lg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-fuchsia-400 ${
                running ? "cursor-not-allowed" : "cursor-crosshair"
              }`}
            />

            {/* committed regions — drawn over the surface, so they must not eat
                the pointer the surface is tracking. */}
            {regions.map((r, i) => (
              <div
                key={i}
                className="pointer-events-none absolute z-2 border-2 border-fuchsia-400 bg-fuchsia-400/15"
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
              >
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    removeRegion(i);
                  }}
                  disabled={running}
                  title="Remove region"
                  className="pointer-events-auto absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500 text-white shadow-sm hover:bg-fuchsia-400 disabled:opacity-40"
                >
                  <Icon icon="heroicons-solid:x-mark" className="h-3 w-3" />
                </button>
              </div>
            ))}

            {/* in-progress draft */}
            {draft && draft.w > 0 && draft.h > 0 && (
              <div
                className="pointer-events-none absolute z-2 border-2 border-dashed border-fuchsia-300 bg-fuchsia-300/10"
                style={{
                  left: `${draft.x * 100}%`,
                  top: `${draft.y * 100}%`,
                  width: `${draft.w * 100}%`,
                  height: `${draft.h * 100}%`,
                }}
              />
            )}
          </div>
          <p className="mt-1 text-[10px] text-[#aec2e8]">
            Drag on the frame to add a search box, or focus it and press Enter — arrow keys move the
            box, Shift with an arrow key resizes it. No box = the whole frame is searched.
          </p>
        </div>

        {/* Time window */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={running}
              className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)] disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={running}
              className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)] disabled:opacity-60"
            />
          </label>
        </div>
        {!windowValid && (from || to) && (
          <p className="text-xs text-amber-500">The end time must be after the start time.</p>
        )}

        {/* Sensitivity */}
        {/* The label carries its own text and points at the slider by id. Wrapping
            the whole block in a <label> whose words sat two spans deep left the
            slider announced as an unnamed range. */}
        <div className="block">
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">
            <label htmlFor="motion-sensitivity">Sensitivity</label>
            <span className="font-mono text-[#f2f6ff]">{sensitivity.toFixed(2)}</span>
          </div>
          <input
            id="motion-sensitivity"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sensitivity}
            onChange={(e) => setSensitivity(Number.parseFloat(e.target.value))}
            disabled={running}
            className="w-full accent-fuchsia-500"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-[#aec2e8]">
            <span>Less (only big motion)</span>
            <span>More (subtle motion)</span>
          </div>
        </div>

        {/* Advanced */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-[#aec2e8] hover:text-[#67e8f9]"
          >
            <Icon
              icon={showAdvanced ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"}
              className="h-3.5 w-3.5"
            />
            Advanced
          </button>
          {showAdvanced && (
            <label className="mt-2 block">
              <span className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">
                <span>Sample rate (fps)</span>
                <span className="font-mono text-[#f2f6ff]">{sampleFps.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={sampleFps}
                onChange={(e) => setSampleFps(Number.parseFloat(e.target.value))}
                disabled={running}
                className="w-full accent-fuchsia-500"
              />
              <p className="mt-0.5 text-[10px] text-[#aec2e8]">
                Frames analysed per second. Higher = more precise hits, slower search.
              </p>
            </label>
          )}
        </div>

        {/* Working. Indeterminate on purpose: the recorder runs the search in one
            call and reports no progress, so a percentage here would be invented. */}
        {running && (
          <div className="rounded-lg border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.08)]/40 px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs text-[#f2f6ff]">
              <Icon icon="svg-spinners:180-ring" className="text-sm text-fuchsia-400" />
              Searching the recorded footage…
            </div>
          </div>
        )}

        {/* Failure */}
        {jobError && !running && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <Icon icon="heroicons:exclamation-triangle" className="mt-0.5 shrink-0" />
            <span>{jobError}</span>
          </div>
        )}

        {/* Results */}
        {hits != null && !running && !jobError && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">
                {hits.length ? `${hits.length} hit${hits.length === 1 ? "" : "s"}` : "No motion found"}
              </span>
            </div>
            {/* An INCOMPLETE search is the dangerous result, not a failed one: an
                empty hit list from a search that gave up reads as "the footage is
                clear". The recorder says which of its bounds bit, and that is shown
                before the hits, not under them. */}
            {result?.complete === false && (
              <div className="mb-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-300">
                <p className="flex items-start gap-1 font-medium">
                  <Icon icon="heroicons:exclamation-triangle" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This search did not cover the whole window.
                </p>
                {(result.notes || []).map((n, i) => (
                  <p key={i} className="mt-0.5 pl-4.5">
                    {n}
                  </p>
                ))}
                {result.examined_from && result.examined_to && (
                  <p className="mt-0.5 pl-4.5 font-mono tabular-nums">
                    Examined {fmtTime(result.examined_from)} – {fmtTime(result.examined_to)}
                  </p>
                )}
              </div>
            )}

            {/* Recording GAPS inside the examined range: footage that does not exist
                cannot be searched, and an operator reading an empty result needs to
                know which minutes were never on disk. */}
            {!!result?.gaps?.length && (
              <p className="mb-1.5 flex items-start gap-1 text-[11px] text-[#aec2e8]">
                <Icon icon="heroicons-outline:information-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {result.gaps.length} recording gap{result.gaps.length === 1 ? "" : "s"} inside this window — there is
                no footage there to search.
              </p>
            )}
            {hits.length > 0 ? (
              <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[rgba(150,180,245,.22)]">
                {hits.map((h, i) => (
                  <li key={`${h.start}-${i}`}>
                    <button
                      type="button"
                      onClick={() => onSeekHit?.(h.start)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[rgba(34,211,238,.08)]"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-fuchsia-500/20 text-[10px] font-medium text-fuchsia-300">
                        {i + 1}
                      </span>
                      <span className="font-mono tabular-nums text-[#f2f6ff]">
                        {fmtTime(h.start)}
                        {h.end ? ` – ${fmtTime(h.end)}` : ""}
                      </span>
                      {typeof h.score === "number" && (
                        <span className="ml-auto font-mono text-[10px] text-[#aec2e8]">
                          {(h.score * 100).toFixed(0)}%
                        </span>
                      )}
                      <Icon icon="heroicons-outline:play" className="h-3.5 w-3.5 text-[#aec2e8]" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-[rgba(150,180,245,.22)] px-3 py-3 text-center text-xs text-[#aec2e8]">
                No motion detected in the selected region and window.
              </p>
            )}

            {/* The method disclosure, verbatim from the recorder and shown on every
                result. A list of timestamps is exactly what somebody reads as
                "three intruders" — this is pixel change, and it says so itself
                rather than being paraphrased here. */}
            {result?.method && (
              <p className="mt-2 border-t border-[rgba(150,180,245,.22)] pt-2 text-[10px] leading-relaxed text-[#aec2e8]">
                {result.method}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
