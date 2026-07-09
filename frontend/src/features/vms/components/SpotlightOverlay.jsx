"use client";

// SpotlightOverlay — the thin control bar shown ABOVE the wall grid while a
// single tile is spotlighted (that tile fills the whole wall). It does NOT
// render the player itself: the Streaming shell keeps the spotlighted WallTile
// mounted with its stable key so its LivePlayer session is REUSED, not
// restarted (see Streaming.jsx render). This just exposes exit + prev/next so
// an operator can flip through cameras without leaving spotlight.
import { Icon } from "@iconify/react";

export default function SpotlightOverlay({ label, position, total, onPrev, onNext, onExit }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center p-3">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/70 px-1.5 py-1 text-white shadow-2xl backdrop-blur-md">
        <button
          type="button"
          title="Previous camera"
          onClick={onPrev}
          disabled={total <= 1}
          className="rounded-full p-1.5 text-white/80 transition hover:bg-white/15 hover:text-white disabled:opacity-30"
        >
          <Icon icon="heroicons-mini:chevron-left" className="text-base" />
        </button>
        <div className="flex items-center gap-1.5 px-2">
          <Icon icon="heroicons-solid:viewfinder-circle" className="text-sm text-blue-400" />
          <span className="max-w-[16rem] truncate text-xs font-medium">{label}</span>
          {total > 1 && (
            <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white/70">
              {position}/{total}
            </span>
          )}
        </div>
        <button
          type="button"
          title="Next camera"
          onClick={onNext}
          disabled={total <= 1}
          className="rounded-full p-1.5 text-white/80 transition hover:bg-white/15 hover:text-white disabled:opacity-30"
        >
          <Icon icon="heroicons-mini:chevron-right" className="text-base" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-white/15" />
        <button
          type="button"
          title="Exit spotlight (Esc)"
          onClick={onExit}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white/85 transition hover:bg-white/15 hover:text-white"
        >
          <Icon icon="heroicons-outline:arrows-pointing-in" className="text-sm" />
          Exit
        </button>
      </div>
    </div>
  );
}
