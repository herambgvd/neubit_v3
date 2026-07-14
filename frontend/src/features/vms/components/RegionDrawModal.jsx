"use client";

// RegionDrawModal (G5) — the shared DRAW TOOL for a camera's privacy masks +
// motion-detection zones.
//
// The operator drags rectangles over a REFERENCE FRAME (the camera snapshot) — the
// same snapshot-blob → normalized-rect approach the G4 MotionSearchModal uses. Each
// rect is stored NORMALIZED (0..1): {x,y} = top-left, {w,h} = size relative to the
// frame, so it survives any resolution/scale. Existing shapes load on open (GET);
// Save (PUT) replaces the whole list.
//
// Two modes via `variant`:
//   "privacy" → masks render as FILLED/blurred blocks ("this area is hidden"), PUT
//                /privacy-masks { masks:[{x,y,w,h}] }.
//   "motion"  → zones render as OUTLINED regions and carry a per-zone `sensitivity`
//                (0..1); PUT /motion-zones { zones:[{x,y,w,h,sensitivity}] }.
//
// The PUT echo carries `pushed` (bool) + `push_error` — we tell the operator whether
// it applied on the device or was only stored locally (brand/ONVIF may not support
// the region config). Writes gate on vms.config.manage (backend enforces too).
//
// Polygons are supported in the payload contract but this tool draws rectangles —
// enough to ship; existing polygon shapes are shown read-only and preserved on save.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { vms } from "../api";

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const isRect = (s) =>
  s && typeof s.x === "number" && typeof s.y === "number" && typeof s.w === "number" && typeof s.h === "number";
const isPoly = (s) => s && Array.isArray(s.points) && s.points.length >= 3;

const VARIANTS = {
  privacy: {
    title: "Privacy masks",
    heading: "Draw masked area(s)",
    empty: "No privacy masks — drag on the frame to hide an area.",
    hint: "Masked areas are blacked out in live view, recordings and exports.",
    // filled/opaque block = "this area is hidden"
    fillClass: "border border-white/40 bg-black/80",
    draftClass: "border border-dashed border-white/70 bg-black/50",
    // static class so Tailwind JIT keeps it (no dynamic `bg-${x}-500`).
    removeBtnClass: "bg-sky-500",
    getFn: (id) => vms.cameras.privacyMasks.get(id),
    putFn: (id, shapes) => vms.cameras.privacyMasks.put(id, shapes),
    listKey: "privacy_masks",
    hasSensitivity: false,
  },
  motion: {
    title: "Motion zones",
    heading: "Draw motion-detection zone(s)",
    empty: "No motion zones — drag on the frame to add a detection region.",
    hint: "Motion is only evaluated inside these zones. No zone = the whole frame.",
    // outlined region = "watch here"
    fillClass: "border-2 border-emerald-400 bg-emerald-400/15",
    draftClass: "border-2 border-dashed border-emerald-300 bg-emerald-300/10",
    removeBtnClass: "bg-emerald-500",
    getFn: (id) => vms.cameras.motionZones.get(id),
    putFn: (id, shapes) => vms.cameras.motionZones.put(id, shapes),
    listKey: "motion_zones",
    hasSensitivity: true,
  },
};

export default function RegionDrawModal({
  open,
  onClose,
  variant = "privacy",
  cameraId,
  cameraName,
  canManage = false,
  // Called after a successful save so the parent can refetch / reflect state.
  onSaved,
}) {
  const cfg = VARIANTS[variant] || VARIANTS.privacy;

  // Reference frame (camera snapshot as a blob object-URL).
  const [frameUrl, setFrameUrl] = useState(null);
  const [frameError, setFrameError] = useState(false);
  const [frameLoading, setFrameLoading] = useState(false);

  // Drawn shapes. Rects are editable; polygons (if any pre-exist) are preserved
  // read-only. Each rect may carry `sensitivity` in the motion variant.
  const [shapes, setShapes] = useState([]);
  const [draft, setDraft] = useState(null); // in-progress rect while dragging (normalized)
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [globalSensitivity, setGlobalSensitivity] = useState(0.5);

  const drawRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY }

  // ── Load existing shapes + a reference frame when opened ──────────────────
  useEffect(() => {
    if (!open || !cameraId) return;
    setShapes([]);
    setDraft(null);
    setLoadError("");
    setGlobalSensitivity(0.5);

    let objectUrl = null;
    let cancelled = false;

    // Snapshot blob — same pattern as MotionSearchModal.
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

    // Existing shapes.
    setLoading(true);
    cfg
      .getFn(cameraId)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.[cfg.listKey]) ? res[cfg.listKey] : [];
        setShapes(list);
        // Seed the global sensitivity slider from the first zone that has one.
        if (cfg.hasSensitivity) {
          const seed = list.find((s) => typeof s.sensitivity === "number");
          if (seed) setGlobalSensitivity(clamp01(seed.sensitivity));
        }
      })
      .catch((e) => !cancelled && setLoadError(apiError(e, "Could not load saved regions")))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cameraId, variant]);

  // ── Draw layer — drag to add a normalized rect ────────────────────────────
  const pointFromEvent = (e) => {
    const box = drawRef.current?.getBoundingClientRect();
    if (!box?.width || !box?.height) return null;
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  const onDrawDown = (e) => {
    if (!canManage) return;
    const p = pointFromEvent(e);
    if (!p) return;
    dragRef.current = { startX: p.x, startY: p.y };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    e.preventDefault();
  };

  const onDrawMove = (e) => {
    if (!dragRef.current) return;
    const p = pointFromEvent(e);
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
        const rect = { x: d.x, y: d.y, w: d.w, h: d.h };
        if (cfg.hasSensitivity) rect.sensitivity = globalSensitivity;
        setShapes((prev) => [...prev, rect]);
      }
      return null;
    });
  };

  const removeShape = (idx) => setShapes((prev) => prev.filter((_, i) => i !== idx));
  const clearShapes = () => setShapes([]);

  // Apply the global sensitivity onto every editable rect (motion variant).
  const applyGlobalSensitivity = (v) => {
    setGlobalSensitivity(v);
    setShapes((prev) => prev.map((s) => (isRect(s) ? { ...s, sensitivity: v } : s)));
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: () => cfg.putFn(cameraId, shapes),
    onSuccess: (res) => {
      const applied = res?.pushed === true;
      const err = res?.push_error;
      if (applied) {
        toast.success("Saved — applied on camera");
      } else {
        toast.success(
          err
            ? `Saved (stored locally — not applied on device: ${err})`
            : "Saved (stored locally — not applied on device)",
        );
      }
      onSaved?.(res);
      onClose?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const rectCount = useMemo(() => shapes.filter(isRect).length, [shapes]);
  const polyCount = useMemo(() => shapes.filter(isPoly).length, [shapes]);
  const summary =
    (rectCount ? `${rectCount} rect${rectCount === 1 ? "" : "s"}` : "") +
    (polyCount ? `${rectCount ? ", " : ""}${polyCount} polygon${polyCount === 1 ? "" : "s"}` : "") ||
    "None";

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`${cfg.title} — ${cameraName || cameraId}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Close
          </Button>
          <Button
            variant="primary"
            icon="heroicons-outline:check"
            disabled={!canManage || save.isPending || loading}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!canManage && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <Icon icon="heroicons-outline:lock-closed" className="mt-0.5 shrink-0" />
            <span>You can view the regions but need the “Manage VMS config” permission to edit them.</span>
          </div>
        )}

        {/* Reference frame + draw layer */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
              {cfg.heading} — {summary}
            </span>
            {rectCount > 0 && canManage && (
              <button
                type="button"
                onClick={clearShapes}
                disabled={save.isPending}
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
              canManage ? "cursor-crosshair" : "cursor-not-allowed"
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

            {/* committed shapes */}
            {shapes.map((s, i) =>
              isRect(s) ? (
                <div
                  key={i}
                  className={`absolute ${cfg.fillClass}`}
                  style={{
                    left: `${s.x * 100}%`,
                    top: `${s.y * 100}%`,
                    width: `${s.w * 100}%`,
                    height: `${s.h * 100}%`,
                  }}
                >
                  {cfg.hasSensitivity && typeof s.sensitivity === "number" && (
                    <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[9px] font-mono text-white/90">
                      {Math.round(s.sensitivity * 100)}%
                    </span>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        removeShape(i);
                      }}
                      disabled={save.isPending}
                      title="Remove"
                      className={`absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full ${cfg.removeBtnClass} text-white shadow hover:opacity-80 disabled:opacity-40`}
                    >
                      <Icon icon="heroicons-solid:x-mark" className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ) : isPoly(s) ? (
                // Pre-existing polygon — shown read-only (bounding box marker).
                <div
                  key={i}
                  className="pointer-events-none absolute border border-dashed border-white/50"
                  style={polyBoundsStyle(s.points)}
                  title="Polygon (read-only)"
                />
              ) : null,
            )}

            {/* in-progress draft */}
            {draft && draft.w > 0 && draft.h > 0 && (
              <div
                className={`absolute ${cfg.draftClass}`}
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
            {canManage ? "Drag on the frame to add a box. " : ""}
            {cfg.hint}
          </p>
        </div>

        {/* Motion-zone sensitivity (applies to all rects) */}
        {cfg.hasSensitivity && (
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted">
              <span>Sensitivity (all zones)</span>
              <span className="font-mono text-foreground">{globalSensitivity.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={globalSensitivity}
              onChange={(e) => applyGlobalSensitivity(parseFloat(e.target.value))}
              disabled={!canManage || save.isPending}
              className="w-full accent-emerald-500"
            />
            <div className="mt-0.5 flex justify-between text-[10px] text-muted">
              <span>Less (only big motion)</span>
              <span>More (subtle motion)</span>
            </div>
          </label>
        )}

        {loadError && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <Icon icon="heroicons-outline:exclamation-triangle" className="mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {polyCount > 0 && (
          <p className="flex items-start gap-1 text-[11px] text-amber-400/90">
            <Icon icon="heroicons-outline:information-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {polyCount} polygon {polyCount === 1 ? "shape is" : "shapes are"} preserved as-is (this tool
            edits rectangles).
          </p>
        )}
      </div>
    </Modal>
  );
}

// Bounding-box style for a normalized polygon (read-only marker).
function polyBoundsStyle(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${(Math.max(...xs) - x) * 100}%`,
    height: `${(Math.max(...ys) - y) * 100}%`,
  };
}
