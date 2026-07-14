"use client";

// LinkageScheduleEditor — the per-rule weekly active window. Matches the backend
// shape the engine evaluates (vision linkage.service._schedule_open):
//   { mon: [["08:00","18:00"], ...], tue: [...], ... }  (lowercase weekday keys,
//   UTC HH:MM windows). An entirely empty schedule = always on; a weekday with no
//   windows = closed that day. Each day toggles Always/Windows; in Windows mode you
//   add [start,end] pairs. Emits the canonical dict via onChange.
import { Icon } from "@iconify/react";

import { Input } from "@/components/ui/kit";

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
];

export default function LinkageScheduleEditor({ value = {}, onChange }) {
  const sched = value && typeof value === "object" ? value : {};
  const isAlwaysOn = Object.keys(sched).length === 0;

  const set = (next) => {
    // Drop empty-array days so a fully-empty schedule collapses to {} (= always on).
    const clean = {};
    for (const [k, v] of Object.entries(next)) {
      if (Array.isArray(v) && v.length) clean[k] = v;
    }
    onChange?.(clean);
  };

  const dayWindows = (key) => (Array.isArray(sched[key]) ? sched[key] : null);

  const addWindow = (key) =>
    set({ ...sched, [key]: [...(dayWindows(key) || []), ["09:00", "17:00"]] });
  const removeWindow = (key, idx) =>
    set({ ...sched, [key]: (dayWindows(key) || []).filter((_, i) => i !== idx) });
  const patchWindow = (key, idx, pos, v) =>
    set({
      ...sched,
      [key]: (dayWindows(key) || []).map((w, i) => (i === idx ? (pos === 0 ? [v, w[1]] : [w[0], v]) : w)),
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md bg-hover/40 px-2.5 py-1.5 text-[11px] text-muted">
        <Icon icon="heroicons-outline:information-circle" className="text-sm" />
        {isAlwaysOn
          ? "Always active — the rule fires any time. Add a day window to restrict it."
          : "Restricted — the rule fires only inside the windows below (UTC). Days with no window are closed."}
      </div>

      <div className="space-y-1.5">
        {DAYS.map(([key, label]) => {
          const windows = dayWindows(key);
          const hasWindows = Array.isArray(windows) && windows.length > 0;
          return (
            <div key={key} className="flex items-start gap-2 rounded-md border border-card-border px-2.5 py-2">
              <span className="mt-1 w-10 shrink-0 text-[11px] font-semibold text-foreground">{label}</span>
              <div className="min-w-0 flex-1">
                {!hasWindows ? (
                  <button
                    type="button"
                    onClick={() => addWindow(key)}
                    className="inline-flex items-center gap-1 rounded-md border border-dashed border-card-border px-2 py-1 text-[10px] text-muted hover:bg-hover hover:text-foreground"
                  >
                    <Icon icon="heroicons-outline:plus" className="text-[10px]" /> Add window
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    {windows.map((w, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <input
                          type="time"
                          value={w[0] || "00:00"}
                          onChange={(e) => patchWindow(key, i, 0, e.target.value)}
                          className="h-8 rounded-md border border-field bg-transparent px-2 text-[11px] text-foreground outline-none focus:border-muted"
                        />
                        <span className="text-[11px] text-muted">–</span>
                        <input
                          type="time"
                          value={w[1] || "23:59"}
                          onChange={(e) => patchWindow(key, i, 1, e.target.value)}
                          className="h-8 rounded-md border border-field bg-transparent px-2 text-[11px] text-foreground outline-none focus:border-muted"
                        />
                        <button
                          type="button"
                          onClick={() => removeWindow(key, i)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-red-500"
                          title="Remove window"
                        >
                          <Icon icon="heroicons-outline:x-mark" className="text-xs" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addWindow(key)}
                      className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-foreground"
                    >
                      <Icon icon="heroicons-outline:plus" className="text-[10px]" /> window
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
