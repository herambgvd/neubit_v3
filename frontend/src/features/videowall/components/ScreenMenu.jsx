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

/** Decoder monitors are deliberately absent from the picker.
 *
 *  A decoder monitor is a hardware decoder output driven over its SDK — the
 *  screen it feeds is not attached to this PC at all. Putting a browser window on
 *  a desk panel and calling it that monitor would produce two things claiming to
 *  be the same output, with no error anywhere.
 *
 *  The shell cannot make this check: `kind` lives in a record it has no session to
 *  read. It validates the SHAPE of the ids it is given; the meaning is ours. */
const assignable = (monitors) => monitors.filter((m) => m.kind !== "decoder");

export default function ScreenMenu({ wall, monitors, screens }) {
  const [open, setOpen] = useState(false);
  if (!screens.available) return null;

  const choices = assignable(monitors);
  const attached = screens.screens.filter((s) => s.attached);
  const openCount = screens.screens.filter((s) => s.open).length;

  const onPick = (signature, monitorId) => {
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
        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(10,18,40,.65)] px-2.5 text-xs font-medium text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
      >
        <Icon icon="heroicons-outline:tv" className="text-sm text-[#9a92c8]" />
        Screens
        {openCount > 0 && (
          <span className="rounded-full border border-[rgba(52,211,153,.45)] bg-[rgba(52,211,153,.1)] px-1.5 font-mono text-[9px] font-semibold text-[#34d399]">
            {openCount}
          </span>
        )}
      </button>

      {open && (
        <div
          // onMouseDown-preventDefault on every control inside: the button above
          // closes the menu on blur, and a click that steals focus first would
          // close it before the click ever lands.
          className="absolute right-0 top-full z-50 mt-1.5 w-[22rem] rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(12,21,44,.97)] py-1 shadow-2xl backdrop-blur-sm"
        >
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">
              This workstation
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={screens.identify}
              title="Flash a label on every screen, so you can tell which is which"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#67e8f9] transition hover:bg-[rgba(34,211,238,.12)]"
            >
              <Icon icon="heroicons-outline:magnifying-glass" className="text-xs" />
              Identify
            </button>
          </div>

          <ul className="max-h-80 overflow-y-auto border-t border-[rgba(160,150,245,.22)] pt-1">
            {attached.length === 0 && (
              <li className="px-3 py-3 text-xs text-[#9a92c8]">No screens reported.</li>
            )}
            {attached.map((s) => (
              <li key={s.signature} className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Icon
                    icon="heroicons:computer-desktop"
                    className={`shrink-0 text-xs ${s.open ? "text-[#34d399]" : "text-[#9a92c8]"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#f2f6ff]">
                    {s.label}
                  </span>
                  {s.primary && (
                    <span className="font-mono text-[9px] uppercase tracking-[.8px] text-[#9a92c8]">
                      primary
                    </span>
                  )}
                  <span className="font-mono text-[9px] tabular-nums text-[#9a92c8]">
                    {s.resolution}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-1.5">
                  {/* A native select rather than another dropdown: this menu is
                      already inside one, and stacking two hand-rolled popovers is
                      how a control ends up clipped by a parent's overflow. */}
                  <select
                    value={s.assignment?.monitorId ?? ""}
                    disabled={screens.busy}
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => onPick(s.signature, e.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-[7px] border border-[rgba(150,180,245,.22)] bg-[rgba(10,18,40,.85)] px-1.5 text-[11px] text-[#f2f6ff] outline-none focus:border-[rgba(34,211,238,.5)]"
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
                      className="shrink-0 rounded p-1 text-[#9a92c8] transition hover:bg-[rgba(248,113,113,.15)] hover:text-[#f87171]"
                    >
                      <Icon icon="heroicons-outline:x-circle" className="text-xs" />
                    </button>
                  )}
                </div>

                {/* An assignment pointing at a DIFFERENT wall is shown by name
                    rather than silently replaced. Somebody who split their desk
                    across two walls meant it, and the select above would otherwise
                    read as "Nothing" while a panel is plainly showing something. */}
                {s.assignment && s.assignment.wallId !== wall.id && (
                  <p className="mt-1 text-[10px] text-[#fbbf24]">
                    Showing {s.assignment.wallLabel} · {s.assignment.monitorLabel} — a different
                    wall.
                  </p>
                )}
                {s.assignment && s.assignment.wallId === wall.id && !s.open && (
                  <p className="mt-1 text-[10px] text-[#9a92c8]">
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
            <div className="border-t border-[rgba(160,150,245,.22)] px-3 py-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">
                Not plugged in
              </span>
              <ul className="mt-1 space-y-0.5">
                {screens.screens
                  .filter((s) => !s.attached)
                  .map((s) => (
                    <li key={s.signature} className="flex items-center gap-1.5 text-[11px]">
                      <Icon
                        icon="heroicons-outline:computer-desktop"
                        className="shrink-0 text-xs text-[#9a92c8]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[#aec2e8]">{s.label}</span>
                      <span className="truncate text-[10px] text-[#9a92c8]">
                        {s.assignment?.monitorLabel}
                      </span>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => screens.clear(s.signature)}
                        title="Forget this screen"
                        className="shrink-0 rounded p-0.5 text-[#9a92c8] transition hover:text-[#f87171]"
                      >
                        <Icon icon="heroicons-outline:x-mark" className="text-[11px]" />
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {openCount > 0 && (
            <div className="border-t border-[rgba(160,150,245,.22)] pt-1">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={screens.closeAll}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[#aec2e8] hover:bg-[rgba(150,180,245,.07)]"
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
