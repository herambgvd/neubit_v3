"use client";

// PlaybackCalendar — a compact month grid for the playback rail (CTOCAM/Lumina
// NVR style). Days that have recorded footage are visually MARKED (accent dot),
// so an operator can see at a glance which days are worth loading. Clicking a
// day selects it and drives the workspace's `day` (YYYY-MM-DD local).
//
//   • prev/next month arrows + "Month YYYY" header
//   • S M T W T F S weekday row, 6-week grid (leading/trailing days dimmed)
//   • footageDays  — a Set of days-of-month (1..31) with recordings, IN view month
//   • selected     — the YYYY-MM-DD currently loaded (highlighted)
//   • month view   — controlled by the parent (viewYear/viewMonth) so the parent
//                    can drive the recording-days query keyed on the visible month.
import { Icon } from "@iconify/react";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n) => String(n).padStart(2, "0");
const dayStr = (y, m0, d) => `${y}-${pad(m0 + 1)}-${pad(d)}`;

export default function PlaybackCalendar({
  viewYear,
  viewMonth, // 0-based
  selected, // YYYY-MM-DD | null
  footageDays, // Set<number> of days-of-month with footage in the view month
  onSelectDay, // (YYYY-MM-DD) => void
  onPrevMonth,
  onNextMonth,
}) {
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Do not let the operator page into future months (no footage there anyway).
  const now = new Date();
  const atCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();
  const todayY = now.getFullYear();
  const todayM = now.getMonth();
  const todayD = now.getDate();

  // 6 rows × 7 cells — a fixed grid so the rail height doesn't jump month-to-month.
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const dayNum = i - firstDow + 1;
    cells.push(dayNum >= 1 && dayNum <= daysInMonth ? dayNum : null);
  }

  return (
    <div className="select-none">
      {/* header — month label + prev/next */}
      <div className="mb-1.5 flex items-center justify-between px-0.5">
        <button
          type="button"
          onClick={onPrevMonth}
          className="rounded-md p-1 text-muted transition hover:bg-hover hover:text-foreground"
          title="Previous month"
        >
          <Icon icon="heroicons-outline:chevron-left" className="text-sm" />
        </button>
        <span className="text-[13px] font-medium text-foreground">
          {MONTHS[viewMonth]} {viewYear}
        </span>
        <button
          type="button"
          onClick={onNextMonth}
          disabled={atCurrentMonth}
          className="rounded-md p-1 text-muted transition hover:bg-hover hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title="Next month"
        >
          <Icon icon="heroicons-outline:chevron-right" className="text-sm" />
        </button>
      </div>

      {/* weekday row */}
      <div className="grid grid-cols-7 gap-0.5 px-0.5 text-center text-[10px] font-medium text-muted">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="py-0.5">
            {w}
          </span>
        ))}
      </div>

      {/* day grid */}
      <div className="grid grid-cols-7 gap-0.5 px-0.5">
        {cells.map((d, i) => {
          if (d == null) return <span key={i} />;
          const ds = dayStr(viewYear, viewMonth, d);
          const isSelected = selected === ds;
          const hasFootage = footageDays?.has(d);
          const isToday =
            viewYear === todayY && viewMonth === todayM && d === todayD;
          const isFuture =
            viewYear > todayY ||
            (viewYear === todayY && viewMonth > todayM) ||
            (viewYear === todayY && viewMonth === todayM && d > todayD);
          return (
            <button
              key={i}
              type="button"
              disabled={isFuture}
              onClick={() => onSelectDay(ds)}
              className={`relative flex h-7 items-center justify-center rounded-md text-[12px] tabular-nums transition ${
                isSelected
                  ? "bg-foreground font-semibold text-background"
                  : isFuture
                    ? "text-muted/40"
                    : `text-foreground hover:bg-hover ${isToday ? "ring-1 ring-inset ring-card-border" : ""}`
              }`}
            >
              {d}
              {/* footage mark — an accent dot under the number (echoes the
                  reference's red-marked recording days). Hidden on the selected
                  cell (the fill already reads as "chosen"). */}
              {hasFootage && !isSelected && (
                <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-red-400" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
