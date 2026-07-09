"use client";

// PatternHud — the on-wall control strip shown while a pattern is rotating.
// Shows the pattern name, current group + position, and prev/pause/next/exit
// controls. In fullscreen it auto-hides after inactivity (mouse move / key wakes
// it). Purely presentational — the rotation engine (usePatternRotation) drives
// the state; this just renders + emits intents.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

export default function PatternHud({
  patternName,
  groupName,
  index,
  total,
  paused,
  seconds,
  onPrev,
  onNext,
  onTogglePause,
  onExit,
}) {
  const [visible, setVisible] = useState(true);
  const hideTimer = useRef(null);

  // Auto-hide after inactivity; any pointer/key activity wakes it. Kept short so
  // the wall stays clean but the controls are one nudge away.
  useEffect(() => {
    const wake = () => {
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 3500);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("touchstart", wake);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("touchstart", wake);
    };
  }, []);

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center p-4 transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-black/80 px-3 py-2 shadow-2xl backdrop-blur">
        <span className="inline-flex items-center gap-1.5 pl-1.5">
          <Icon icon="heroicons-solid:squares-2x2" className="text-sm text-blue-400" />
          <span className="max-w-[12rem] truncate text-xs font-semibold text-white">{patternName}</span>
        </span>

        <span className="h-5 w-px bg-white/15" />

        <HudBtn icon="heroicons-solid:chevron-left" title="Previous group" onClick={onPrev} disabled={total <= 1} />
        <HudBtn
          icon={paused ? "heroicons-solid:play" : "heroicons-solid:pause"}
          title={paused ? "Resume rotation" : "Pause rotation"}
          onClick={onTogglePause}
          accent
        />
        <HudBtn icon="heroicons-solid:chevron-right" title="Next group" onClick={onNext} disabled={total <= 1} />

        <span className="flex min-w-0 flex-col px-1 leading-tight">
          <span className="max-w-[14rem] truncate text-xs font-medium text-white">
            {groupName || "—"}
          </span>
          <span className="text-[10px] tabular-nums text-white/50">
            Group {total ? index + 1 : 0} / {total} · {paused ? "paused" : `${seconds}s dwell`}
          </span>
        </span>

        <span className="h-5 w-px bg-white/15" />

        <HudBtn icon="heroicons-solid:x-mark" title="Exit pattern" onClick={onExit} danger />
      </div>
    </div>
  );
}

function HudBtn({ icon, title, onClick, disabled, accent, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition disabled:opacity-30 ${
        accent
          ? "bg-blue-500/90 !text-white hover:bg-blue-400"
          : danger
            ? "hover:bg-red-500/80 hover:text-white"
            : "hover:bg-white/15 hover:text-white"
      }`}
    >
      <Icon icon={icon} className="text-base" />
    </button>
  );
}
