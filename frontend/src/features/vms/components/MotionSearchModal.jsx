"use client";

// MotionSearchModal (G4) — Smart / forensic motion search over recorded footage.
//
// The investigator draws one or more region rectangles over a REFERENCE FRAME (a
// snapshot of the camera), picks a time window + sensitivity, and runs a VMD job
// (ffmpeg motion energy on the cropped region — NOT AI). The backend returns hit
// intervals which the caller plots on the ScrubBar and lists for click-to-seek.
//
// Regions are stored NORMALIZED (0..1): {x,y} = top-left, {w,h} = size relative to
// the frame. An empty region list = whole frame. Both start + poll gate on
// vms.playback.view (the backend enforces it too).
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { vms } from "../api";

// ISO ↔ the value a datetime-local input wants (local wall-clock).
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour12: false });

export default function MotionSearchModal({
  open,
  onClose,
  cameraId,
  cameraName,
  // Seed window (ISO) — defaults to the loaded playback window.
  seedFrom = null,
  seedTo = null,
  // ({ hits, jobId, note }) => void — called on a successful `done` so the parent
  // can plot the intervals on the timeline. Also fires with hits:[] to clear.
  onResults,
  // (iso) => void — click a hit → seek playback there.
  onSeekHit,
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sensitivity, setSensitivity] = useState(0.5);
  const [sampleFps, setSampleFps] = useState(4);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reference frame (camera snapshot as a blob object-URL).
  const [frameUrl, setFrameUrl] = useState(null);
  const [frameError, setFrameError] = useState(false);
  const [frameLoading, setFrameLoading] = useState(false);

  // Drawn regions — normalized rects { x, y, w, h }.
  const [regions, setRegions] = useState([]);
  const [draft, setDraft] = useState(null); // in-progress rect while dragging (normalized)

  // Job lifecycle.
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [hits, setHits] = useState(null); // null = not run yet; [] = ran, no hits
  const [note, setNote] = useState("");
  const [jobError, setJobError] = useState("");

  const drawRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY }
  const abortRef = useRef(null);

  // ── Seed window + fetch a reference frame when opened ────────────────────
  useEffect(() => {
    if (!open) return;
    setFrom(toLocalInput(seedFrom) || toLocalInput(new Date(Date.now() - 3_600_000).toISOString()));
    setTo(toLocalInput(seedTo) || toLocalInput(new Date().toISOString()));
    setRegions([]);
    setDraft(null);
    setHits(null);
    setNote("");
    setJobError("");
    setProgress(0);
    setRunning(false);
    setStatusText("");

    let objectUrl = null;
    let cancelled = false;
    setFrameLoading(true);
    setFrameError(false);
    setFrameUrl(null);
    api
      .get(vms.cameras.snapshotUrl(cameraId), { responseType: "blob" })
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
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cameraId, seedFrom, seedTo]);

  // ── Draw layer — drag to add a normalized rect ───────────────────────────
  const rectFromEvent = (e) => {
    const box = drawRef.current?.getBoundingClientRect();
    if (!box?.width || !box?.height) return null;
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  const onDrawDown = (e) => {
    if (running) return;
    const p = rectFromEvent(e);
    if (!p) return;
    dragRef.current = { startX: p.x, startY: p.y };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    e.preventDefault();
  };

  const onDrawMove = (e) => {
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

  const removeRegion = (idx) => setRegions((prev) => prev.filter((_, i) => i !== idx));
  const clearRegions = () => setRegions([]);

  // ── Run the search ────────────────────────────────────────────────────────
  const fromIso = fromLocalInput(from);
  const toIso = fromLocalInput(to);
  const windowValid = fromIso && toIso && new Date(toIso) > new Date(fromIso);
  const canRun = !!cameraId && windowValid && !running;

  const runSearch = async () => {
    if (!canRun) return;
    setRunning(true);
    setProgress(0);
    setHits(null);
    setNote("");
    setJobError("");
    setStatusText("Queuing…");
    onResults?.({ hits: [], jobId: null, note: "" }); // clear any prior plot

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const started = await vms.motionSearch.start(cameraId, {
        from: fromIso,
        to: toIso,
        regions, // [] = whole frame
        sensitivity,
        sample_fps: sampleFps,
      });
      const jobId = started?.job_id;
      if (!jobId) throw new Error("No job id returned");
      setStatusText("Analyzing footage…");

      const job = await vms.motionSearch.poll(jobId, {
        intervalMs: 1500,
        signal: controller.signal,
        onTick: (j) => {
          setProgress(typeof j?.progress === "number" ? j.progress : 0);
          setStatusText(
            j?.status === "running" ? "Analyzing footage…" : j?.status === "queued" ? "Queued…" : "",
          );
        },
      });

      if (job.status === "failed") {
        setJobError(job.error || "Motion search failed");
        setHits([]);
        toast.error(job.error || "Motion search failed");
      } else {
        const found = Array.isArray(job.hits) ? job.hits : [];
        setHits(found);
        setNote(job.note || "");
        onResults?.({ hits: found, jobId, note: job.note || "" });
        toast.success(found.length ? `${found.length} motion hit${found.length === 1 ? "" : "s"} found` : "No motion in the selected region");
      }
    } catch (e) {
      if (e?.name === "AbortError") return; // modal closed / cancelled
      setJobError(apiError(e, "Motion search failed"));
      setHits([]);
      toast.error(apiError(e, "Motion search failed"));
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const cancelRun = () => {
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
    setStatusText("");
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
            <Button variant="secondary" icon="heroicons-outline:x-circle" onClick={cancelRun}>
              Cancel
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
        <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2 text-sm">
          <span className="text-muted">Camera</span>{" "}
          <span className="font-medium text-foreground">{cameraName || cameraId}</span>
        </div>

        {/* Reference frame + draw layer */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Draw region(s) to search — {regionSummary}
            </span>
            {regions.length > 0 && (
              <button
                type="button"
                onClick={clearRegions}
                disabled={running}
                className="text-[11px] text-muted hover:text-foreground disabled:opacity-40"
              >
                Clear all
              </button>
            )}
          </div>
          <div
            ref={drawRef}
            onMouseDown={onDrawDown}
            onMouseMove={onDrawMove}
            onMouseUp={onDrawUp}
            onMouseLeave={onDrawUp}
            className={`relative aspect-video w-full select-none overflow-hidden rounded-lg border border-card-border bg-black ${
              running ? "cursor-not-allowed" : "cursor-crosshair"
            }`}
          >
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

            {/* committed regions */}
            {regions.map((r, i) => (
              <div
                key={i}
                className="absolute border-2 border-fuchsia-400 bg-fuchsia-400/15"
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
                  className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500 text-white shadow hover:bg-fuchsia-400 disabled:opacity-40"
                >
                  <Icon icon="heroicons-solid:x-mark" className="h-3 w-3" />
                </button>
              </div>
            ))}

            {/* in-progress draft */}
            {draft && draft.w > 0 && draft.h > 0 && (
              <div
                className="absolute border-2 border-dashed border-fuchsia-300 bg-fuchsia-300/10"
                style={{
                  left: `${draft.x * 100}%`,
                  top: `${draft.y * 100}%`,
                  width: `${draft.w * 100}%`,
                  height: `${draft.h * 100}%`,
                }}
              />
            )}
          </div>
          <p className="mt-1 text-[10px] text-muted">
            Drag on the frame to add a search box. No box = the whole frame is searched.
          </p>
        </div>

        {/* Time window */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={running}
              className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={running}
              className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted disabled:opacity-60"
            />
          </label>
        </div>
        {!windowValid && (from || to) && (
          <p className="text-xs text-amber-500">The end time must be after the start time.</p>
        )}

        {/* Sensitivity */}
        <label className="block">
          <span className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted">
            <span>Sensitivity</span>
            <span className="font-mono text-foreground">{sensitivity.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sensitivity}
            onChange={(e) => setSensitivity(parseFloat(e.target.value))}
            disabled={running}
            className="w-full accent-fuchsia-500"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-muted">
            <span>Less (only big motion)</span>
            <span>More (subtle motion)</span>
          </div>
        </label>

        {/* Advanced */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
          >
            <Icon
              icon={showAdvanced ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"}
              className="h-3.5 w-3.5"
            />
            Advanced
          </button>
          {showAdvanced && (
            <label className="mt-2 block">
              <span className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted">
                <span>Sample rate (fps)</span>
                <span className="font-mono text-foreground">{sampleFps.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={sampleFps}
                onChange={(e) => setSampleFps(parseFloat(e.target.value))}
                disabled={running}
                className="w-full accent-fuchsia-500"
              />
              <p className="mt-0.5 text-[10px] text-muted">
                Frames analysed per second. Higher = more precise hits, slower search.
              </p>
            </label>
          )}
        </div>

        {/* Progress */}
        {running && (
          <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <div className="mb-1.5 flex items-center gap-2 text-xs text-foreground">
              <Icon icon="svg-spinners:180-ring" className="text-sm text-fuchsia-400" />
              {statusText || "Working…"}
              <span className="ml-auto font-mono text-muted">{Math.round((progress || 0) * 100)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-card-border/60">
              <div
                className="h-full rounded-full bg-fuchsia-500 transition-all"
                style={{ width: `${Math.round((progress || 0) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Failure */}
        {jobError && !running && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <Icon icon="heroicons-outline:exclamation-triangle" className="mt-0.5 shrink-0" />
            <span>{jobError}</span>
          </div>
        )}

        {/* Results */}
        {hits != null && !running && !jobError && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {hits.length ? `${hits.length} hit${hits.length === 1 ? "" : "s"}` : "No motion found"}
              </span>
            </div>
            {note && (
              <p className="mb-1.5 flex items-start gap-1 text-[11px] text-amber-400/90">
                <Icon icon="heroicons-outline:information-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {note}
              </p>
            )}
            {hits.length > 0 ? (
              <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-card-border">
                {hits.map((h, i) => (
                  <li key={`${h.start}-${i}`}>
                    <button
                      type="button"
                      onClick={() => onSeekHit?.(h.start)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-hover"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded bg-fuchsia-500/20 text-[10px] font-medium text-fuchsia-300">
                        {i + 1}
                      </span>
                      <span className="font-mono tabular-nums text-foreground">
                        {fmtTime(h.start)}
                        {h.end ? ` – ${fmtTime(h.end)}` : ""}
                      </span>
                      {typeof h.score === "number" && (
                        <span className="ml-auto font-mono text-[10px] text-muted">
                          {(h.score * 100).toFixed(0)}%
                        </span>
                      )}
                      <Icon icon="heroicons-outline:play" className="h-3.5 w-3.5 text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-card-border px-3 py-3 text-center text-xs text-muted">
                No motion detected in the selected region and window.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
