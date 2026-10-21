"use client";

// "Screens" on the live wall — a live view of its own on each of this station's
// other monitors (SCRUM-336). See liveScreens.ts for why and how.
//
// Not the video wall's Screens menu (features/videowall/components/ScreenMenu),
// and deliberately so: that one puts a monitor of a SHARED, server-side wall on a
// screen; this one gives the operator's own desk more glass. Both edit the same
// per-screen record in the desktop app, so each says when a screen is the other's.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { useLiveScreens, type LiveScreenRow } from "../hooks/useLiveScreens";

type Screens = ReturnType<typeof useLiveScreens>;

const ROW_BTN =
  "shrink-0 rounded-[7px] border px-2 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40";

export default function LiveScreensMenu() {
  const screens = useLiveScreens();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node | null)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Screens — a live view of its own on each of this station's monitors"
        aria-label="Screens"
        aria-expanded={open}
        className={`relative inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border transition ${
          screens.liveCount > 0
            ? "border-nb-teal/50 bg-nb-teal/15 text-nb-tealb"
            : "border-nb-mist/22 text-nb-soft hover:border-nb-teal/60 hover:text-nb-teal"
        }`}
      >
        <Icon icon="heroicons:tv" className="text-base" />
        {screens.liveCount > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full border border-nb-good/45 bg-nb-surface px-1 font-mono text-[9px] font-semibold tabular-nums text-nb-good">
            {screens.liveCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[22rem] rounded-[13px] border border-nb-haze/22 bg-nb-surface/97 py-1 shadow-2xl backdrop-blur-sm">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">
              This station&apos;s screens
            </span>
            {screens.identify && (
              <button
                type="button"
                onClick={screens.identify}
                title="Flash a label on every screen, so you can tell which is which"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-nb-tealb transition hover:bg-nb-teal/12"
              >
                <Icon icon="heroicons-outline:magnifying-glass" className="text-xs" />
                Identify
              </button>
            )}
          </div>
          <ScreensBody screens={screens} />
          <p className="border-t border-nb-haze/22 px-3 pb-1 pt-2 text-[10px] leading-snug text-nb-faint">
            Drag a camera from the rail, or a tile, onto another screen to put it there.
          </p>
        </div>
      )}
    </div>
  );
}

/** What the menu can offer depends on what this console can reach. */
function ScreensBody({ screens }: Readonly<{ screens: Screens }>) {
  const listed = <ScreenRows screens={screens} />;
  if (screens.mode === "desktop") return listed;

  if (screens.mode === "browser" && screens.access === "granted") {
    return (
      <>
        {listed}
        <NewWindowAction screens={screens} label="Or open one in a window of its own" />
      </>
    );
  }

  return (
    <>
      <BrowserHint screens={screens} />
      {listed}
      <NewWindowAction screens={screens} label="Open a live view in a new window" />
    </>
  );
}

function BrowserHint({ screens }: Readonly<{ screens: Screens }>) {
  if (screens.mode === "browser" && screens.access === "prompt") {
    return (
      <div className="border-t border-nb-haze/22 px-3 py-2">
        <p className="text-[11px] leading-snug text-nb-soft">
          Let this site see your monitors, and a live view opens straight on the one you pick.
        </p>
        <button
          type="button"
          onClick={() => void screens.findScreens()}
          className={`${ROW_BTN} mt-1.5 border-nb-teal/45 bg-nb-teal/12 text-nb-tealb hover:bg-nb-teal/20`}
        >
          Find my screens
        </button>
      </div>
    );
  }
  const text =
    screens.mode === "browser"
      ? "This site is not allowed to see your monitors. Allow “Window management” in the browser's site settings, or open a window and move it yourself."
      : "This browser cannot place a window on a monitor. Open a live view in a new window, move it to the other screen and use its full-screen button — or use the Neubit VMS desktop app, which does it for you.";
  return <p className="border-t border-nb-haze/22 px-3 py-2 text-[11px] leading-snug text-nb-soft">{text}</p>;
}

function ScreenRows({ screens }: Readonly<{ screens: Screens }>) {
  if (screens.rows.length === 0) {
    return screens.mode === "desktop" ? (
      <p className="border-t border-nb-haze/22 px-3 py-3 text-xs text-nb-faint">No screens reported.</p>
    ) : null;
  }
  return (
    <ul className="max-h-80 overflow-y-auto border-t border-nb-haze/22 py-1">
      {screens.rows.map((row) => (
        <li key={row.id} className="flex items-center gap-2 px-3 py-1.5">
          <Icon
            icon="heroicons:computer-desktop"
            className={`shrink-0 text-xs ${row.live ? "text-nb-good" : "text-nb-faint"}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-nb-ink">{row.label}</span>
              {row.primary && (
                <span className="font-mono text-[9px] uppercase tracking-[.8px] text-nb-faint">primary</span>
              )}
            </div>
            <RowDetail row={row} />
          </div>
          <RowAction row={row} screens={screens} />
        </li>
      ))}
    </ul>
  );
}

function RowDetail({ row }: Readonly<{ row: LiveScreenRow }>) {
  const parts = [row.detail, row.detached ? "Not plugged in" : null, row.live ? "Live view open" : row.note].filter(
    Boolean,
  );
  if (parts.length === 0) return null;
  return <div className="truncate font-mono text-[9.5px] tabular-nums text-nb-faint">{parts.join(" · ")}</div>;
}

function RowAction({ row, screens }: Readonly<{ row: LiveScreenRow; screens: Screens }>) {
  if (row.console) {
    return <span className="shrink-0 text-[10px] text-nb-faint">This console</span>;
  }
  if (row.live || row.detached) {
    return (
      <button
        type="button"
        disabled={screens.busy}
        onClick={() => screens.closeLive(row)}
        title={row.live ? "Close the live view on this screen" : "Forget this screen"}
        className={`${ROW_BTN} border-nb-mist/22 text-nb-soft hover:border-nb-crit/50 hover:text-nb-crit`}
      >
        {row.live ? "Close" : "Forget"}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={screens.busy}
      onClick={() => screens.openLive(row)}
      title={row.note ? "Show a live view here instead" : "Open a live view of its own on this screen"}
      className={`${ROW_BTN} border-nb-teal/45 bg-nb-teal/12 text-nb-tealb hover:bg-nb-teal/20`}
    >
      Open live view
    </button>
  );
}

function NewWindowAction({ screens, label }: Readonly<{ screens: Screens; label: string }>) {
  return (
    <div className="border-t border-nb-haze/22 pt-1">
      <button
        type="button"
        onClick={screens.openWindow}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-nb-soft hover:bg-nb-mist/7"
      >
        <Icon icon="heroicons-outline:arrow-top-right-on-square" className="shrink-0 text-xs" />
        {label}
      </button>
    </div>
  );
}
