"use client";

// Weekly recording-schedule painter — 7 days × 24 hours. Click-drag to paint
// each hour-cell with a recording mode (Record / Motion / Off). Ported from
// gvd_nvr's RecordingScheduleGrid, reskinned to v3's dark tokens.
//
// Schedule shape (the `recording_schedule` weekly-windows JSON):
//   { Mon: [24 × "record"|"motion"|"off"], Tue: [...], ... Sun: [...] }
// A missing/empty schedule defaults to all-"record".
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";
import { SCHEDULE_MODES } from "../constants";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

// A fresh all-"record" week.
export function defaultSchedule() {
  return Object.fromEntries(DAYS.map((d) => [d, Array(24).fill("record")]));
}

// Coerce an arbitrary stored value into the canonical { day: [24] } shape.
export function normalizeSchedule(value) {
  const base = defaultSchedule();
  if (!value || typeof value !== "object") return base;
  for (const day of DAYS) {
    const row = value[day];
    if (Array.isArray(row) && row.length === 24) {
      base[day] = row.map((v) => (SCHEDULE_MODES[v] ? v : "off"));
    }
  }
  return base;
}

export default function RecordingScheduleGrid({ value, onChange }) {
  const [schedule, setSchedule] = useState(() => normalizeSchedule(value));
  const [paintMode, setPaintMode] = useState("record");
  const painting = useRef(false);

  // Re-hydrate when the parent swaps in a different camera's schedule.
  useEffect(() => {
    setSchedule(normalizeSchedule(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const push = useCallback(
    (next) => {
      setSchedule(next);
      onChange?.(next);
    },
    [onChange],
  );

  const paintCell = (day, hour) => {
    push({
      ...schedule,
      [day]: schedule[day].map((v, i) => (i === hour ? paintMode : v)),
    });
  };

  const fillAll = (mode) => push(Object.fromEntries(DAYS.map((d) => [d, Array(24).fill(mode)])));

  const stopPaint = () => {
    painting.current = false;
  };

  return (
    <div className="space-y-3" onMouseUp={stopPaint} onMouseLeave={stopPaint}>
      {/* Paint-mode legend + bulk fills */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Paint</span>
        {Object.entries(SCHEDULE_MODES).map(([key, m]) => (
          <button
            key={key}
            type="button"
            onClick={() => setPaintMode(key)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${
              paintMode === key
                ? "border-foreground text-foreground"
                : "border-card-border text-muted hover:bg-hover"
            }`}
          >
            <span className={`inline-block h-3 w-3 rounded-sm ${m.swatch}`} />
            {m.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1.5">
          <Button variant="secondary" className="!px-2 !py-1 !text-xs" onClick={() => fillAll("record")}>
            All record
          </Button>
          <Button variant="secondary" className="!px-2 !py-1 !text-xs" onClick={() => fillAll("motion")}>
            All motion
          </Button>
          <Button
            variant="secondary"
            icon="heroicons-outline:x-mark"
            className="!px-2 !py-1 !text-xs"
            onClick={() => fillAll("off")}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* The 7×24 grid */}
      <div className="overflow-x-auto rounded-lg border border-card-border bg-hover/30 p-3">
        <table className="select-none border-collapse" style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th className="w-9" />
              {HOURS.map((h) => (
                <th
                  key={h}
                  className="text-center text-[10px] font-normal text-muted"
                  style={{ width: 22 }}
                >
                  {h % 3 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day) => (
              <tr key={day}>
                <td className="pr-2 text-right text-[11px] font-medium text-muted">{day}</td>
                {HOURS.map((h) => {
                  const mode = schedule[day]?.[h] || "off";
                  const m = SCHEDULE_MODES[mode] || SCHEDULE_MODES.off;
                  return (
                    <td
                      key={h}
                      role="button"
                      title={`${day} ${String(h).padStart(2, "0")}:00 — ${m.label}`}
                      className={`cursor-pointer border border-background ${m.color} transition hover:opacity-80`}
                      style={{ width: 22, height: 20 }}
                      onMouseDown={() => {
                        painting.current = true;
                        paintCell(day, h);
                      }}
                      onMouseEnter={() => {
                        if (painting.current) paintCell(day, h);
                      }}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <Icon icon="heroicons-outline:information-circle" className="text-sm" />
        Click and drag to paint. Each cell is one hour. Applies when the recording mode is
        &ldquo;Schedule&rdquo;.
      </p>
    </div>
  );
}
