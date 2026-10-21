"use client";

// "Screens" — the desktop-only control that turns the panels on an operator's
// desk into monitors of this wall.
//
// ══ WHY THIS IS THE ONLY PLACE THE SHELL TOUCHES THE WALL ═══════════════════
//
// The wall's CONTENT is the server's: which camera is in which cell is one shared
// blob pushed to every client over SSE, so a camera dropped here appears on every
// panel and on every other operator's console a frame later. The desktop shell
// adds exactly one thing to that — putting a given monitor full screen on a given
// piece of glass, and remembering it across a restart, which a browser tab cannot
// do for itself.
//
// So the shell is told two ids and nothing else. It builds the URL itself from
// the server the app is already pointed at; it is not handed one. See
// desktop/src/main/screens.ts for the other half of that split.
//
// In a browser this component renders nothing at all: `screens.available` is
// false and the toolbar is the toolbar it has always been. One console, one
// build — see lib/desktop.js.
import { useState } from "react";
import { Icon } from "@iconify/react";

import { isLiveAssignment, isWallAssignment, type ScreenAssignment, type useScreens } from "@/lib/desktop";

import type { WallPublic } from "../types";
import type { WallMonitor } from "../wallLayout";

/** Decoder monitors are deliberately absent from the picker.
 *
 *  A decoder monitor is a hardware decoder output driven over its SDK — the
 *  screen it feeds is not attached to this PC at all. Putting a browser window on
 *  a desk panel and calling it that monitor would produce two things claiming to
 *  be the same output, with no error anywhere.
 *
 *  The shell cannot make this check: `kind` lives in a record it has no session to
 *  read. It validates the SHAPE of the ids it is given; the meaning is ours. */
const assignable = (monitors: WallMonitor[]) => monitors.filter((m) => m.kind !== "decoder");

/** The monitor a screen shows, or "" — a screen with a live view on it shows none. */
const monitorOf = (a: ScreenAssignment | null) => (isWallAssignment(a) ? a.monitorId : "");

/** What a saved screen shows, in the words of the "Not plugged in" list. */
const shownOn = (a: ScreenAssignment | null) => {
  if (isLiveAssignment(a)) return "Live view";
  return a?.monitorLabel ?? "";
};

export interface ScreenMenuProps {
  wall: WallPublic;
  monitors: WallMonitor[];
  /** The desktop-shell screen panel — `useScreens()`. In a browser its
   *  `available` is false and this component renders nothing. */
  screens: ReturnType<typeof useScreens>;
}

export default function ScreenMenu({ wall, monitors, screens }: Readonly<ScreenMenuProps>) {
  const [open, setOpen] = useState(false);
  if (!screens.available) return null;

  const choices = assignable(monitors);
  const attached = screens.screens.filter((s) => s.attached);
  const openCount = screens.screens.filter((s) => s.open).length;

  const onPick = (signature: string, monitorId: string) => {
    if (!monitorId) {
      screens.clear(signature);
      return;
    }
    const monitor = choices.find((m) => m.id === monitorId);
    if (!monitor) return;
    screens.assign(signature, {
      wallId: wall.id,
      monitorId: monitor.id,
      // Sent so the shell can describe the assignment later without a call it has
      // no session to make — including while this server is unreachable.
      wallLabel: wall.name || "Wall",
      monitorLabel: monitor.name || "Monitor",
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        title="Put this wall's monitors on the screens attached to this workstation"
        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-nb-mist/22 bg-nb-surface/65 px-2.5 text-xs font-medium text-nb-soft transition hover:border-nb-teal/50 hover:text-nb-tealb"
      >
        <Icon icon="heroicons:tv" className="text-sm text-nb-faint" />
        Screens
        {openCount > 0 && (
          <span className="rounded-full border border-nb-good/45 bg-nb-good/10 px-1.5 font-mono text-[9px] font-semibold text-nb-good">
            {openCount}
          </span>
        )}
      </button>

      {open && (
        <div
          // onMouseDown-preventDefault on every control inside: the button above
          // closes the menu on blur, and a click that steals focus first would
          // close it before the click ever lands.
          className="absolute right-0 top-full z-50 mt-1.5 w-[22rem] rounded-[13px] border border-nb-haze/22 bg-nb-surface/97 py-1 shadow-2xl backdrop-blur-sm"
        >
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">
              This workstation
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={screens.identify}
              title="Flash a label on every screen, so you can tell which is which"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-nb-tealb transition hover:bg-nb-teal/12"
            >
              <Icon icon="heroicons-outline:magnifying-glass" className="text-xs" />
              Identify
            </button>
          </div>

          <ul className="max-h-80 overflow-y-auto border-t border-nb-haze/22 pt-1">
            {attached.length === 0 && (
              <li className="px-3 py-3 text-xs text-nb-faint">No screens reported.</li>
            )}
            {attached.map((s) => (
              <li key={s.signature} className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Icon
                    icon="heroicons:computer-desktop"
                    className={`shrink-0 text-xs ${s.open ? "text-nb-good" : "text-nb-faint"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-nb-ink">
                    {s.label}
                  </span>
                  {s.primary && (
                    <span className="font-mono text-[9px] uppercase tracking-[.8px] text-nb-faint">
                      primary
                    </span>
                  )}
                  <span className="font-mono text-[9px] tabular-nums text-nb-faint">
                    {s.resolution}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-1.5">
                  {/* A native select rather than another dropdown: this menu is
                      already inside one, and stacking two hand-rolled popovers is
                      how a control ends up clipped by a parent's overflow. */}
                  <select
                    value={monitorOf(s.assignment)}
                    disabled={screens.busy}
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => onPick(s.signature, e.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-[7px] border border-nb-mist/22 bg-nb-surface/85 px-1.5 text-[11px] text-nb-ink outline-none focus:border-nb-teal/50"
                  >
                    <option value="">Nothing — leave this screen alone</option>
                    {choices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  {s.assignment && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => screens.clear(s.signature)}
                      title="Close this panel and forget the assignment"
                      className="shrink-0 rounded p-1 text-nb-faint transition hover:bg-nb-crit/15 hover:text-nb-crit"
                    >
                      <Icon icon="heroicons-outline:x-circle" className="text-xs" />
                    </button>
                  )}
                </div>

                {/* An assignment pointing at a DIFFERENT wall is shown by name
                    rather than silently replaced. Somebody who split their desk
                    across two walls meant it, and the select above would otherwise
                    read as "Nothing" while a panel is plainly showing something. */}
                {isWallAssignment(s.assignment) && s.assignment.wallId !== wall.id && (
                  <p className="mt-1 text-[10px] text-nb-warn">
                    Showing {s.assignment.wallLabel} · {s.assignment.monitorLabel} — a different
                    wall.
                  </p>
                )}
                {/* The operator's own live view (SCRUM-336) — said so, for the same
                    reason: a select reading "Nothing" over a screen full of video. */}
                {isLiveAssignment(s.assignment) && (
                  <p className="mt-1 text-[10px] text-nb-faint">
                    Showing a live view. Picking a monitor replaces it.
                  </p>
                )}
                {isWallAssignment(s.assignment) && s.assignment.wallId === wall.id && !s.open && (
                  <p className="mt-1 text-[10px] text-nb-faint">
                    Saved, but no panel is open — the server was not reachable when it was
                    restored.
                  </p>
                )}
              </li>
            ))}
          </ul>

          {/* Detached screens are listed, not dropped: a station gets taken apart,
              a panel dies, somebody carries the box to a one-screen desk. */}
          {screens.screens.some((s) => !s.attached) && (
            <div className="border-t border-nb-haze/22 px-3 py-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">
                Not plugged in
              </span>
              <ul className="mt-1 space-y-0.5">
                {screens.screens
                  .filter((s) => !s.attached)
                  .map((s) => (
                    <li key={s.signature} className="flex items-center gap-1.5 text-[11px]">
                      <Icon
                        icon="heroicons-outline:computer-desktop"
                        className="shrink-0 text-xs text-nb-faint"
                      />
                      <span className="min-w-0 flex-1 truncate text-nb-soft">{s.label}</span>
                      <span className="truncate text-[10px] text-nb-faint">
                        {shownOn(s.assignment)}
                      </span>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => screens.clear(s.signature)}
                        title="Forget this screen"
                        className="shrink-0 rounded p-0.5 text-nb-faint transition hover:text-nb-crit"
                      >
                        <Icon icon="heroicons-outline:x-mark" className="text-[11px]" />
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {openCount > 0 && (
            <div className="border-t border-nb-haze/22 pt-1">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={screens.closeAll}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-nb-soft hover:bg-nb-mist/7"
              >
                <Icon icon="heroicons-outline:x-circle" className="shrink-0 text-xs" />
                Close the panels — keep the layout
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
