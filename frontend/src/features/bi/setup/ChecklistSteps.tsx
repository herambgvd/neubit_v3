"use client";

// BI → SETUP, drawn as a PATH rather than as six equal rows.
//
// WHY THIS SHAPE. The six tasks are not a menu: they depend on each other, and
// an operator who does gate 2 on gate 1's ghosts confirms units on points that
// will never report again. Six identical rows say "pick one"; a path says
// "this one, then that". So exactly one step is open at a time — the first
// that is not done — and it carries what a person meeting this screen actually
// lacks: the question the gate asks, why it is worth answering, and what
// answering it frees. The other five stay one quiet line each, because they
// are context, not instructions.
//
// AN `unknown` STEP STILL OPENS. A read that failed cannot say a gate is fine,
// so the walk stops there and the step says what did not answer — it does not
// skip ahead and imply the gate is clear.
import Link from "next/link";
import { Icon } from "@iconify/react";

import type { ChecklistRow, ChecklistState } from "./checklist";

const STATE_STYLE: Record<ChecklistState, { icon: string; cls: string }> = {
  done: { icon: "heroicons:check-circle", cls: "border-[rgba(52,211,153,.45)] text-nb-good" },
  partly: { icon: "heroicons:exclamation-circle", cls: "border-nb-warn/45 text-nb-warn" },
  todo: { icon: "heroicons-outline:minus-circle", cls: "border-nb-line text-nb-muted" },
  unknown: { icon: "heroicons:question-mark-circle", cls: "border-nb-line text-nb-faint" },
};

/** The marker on the spine: a tick once the step is done, else its number. */
function Marker({ state, n, open }: Readonly<{ state: ChecklistState; n: number; open: boolean }>) {
  const size = open ? "h-10 w-10 text-[15px]" : "h-7 w-7 text-[11.5px]";
  if (state === "done") {
    return (
      <span
        className={`flex flex-none items-center justify-center rounded-full border border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good ${size}`}
      >
        <Icon icon="heroicons-outline:check" className={open ? "text-[19px]" : "text-[14px]"} />
      </span>
    );
  }
  const tone =
    state === "partly"
      ? "border-nb-warn/50 bg-nb-warn/10 text-nb-warn"
      : state === "unknown"
        ? "border-nb-line bg-nb-sunk text-nb-faint"
        : "border-nb-line bg-nb-sunk text-nb-muted";
  const lit = open ? "border-nb-blue/60 bg-nb-blue/15 text-nb-blueb" : tone;
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full border font-mono ${lit} ${size}`}
    >
      {n}
    </span>
  );
}

/** How much of a task is done, when the read could measure BOTH ends of it. */
function Bar({ done, total }: Readonly<{ done: number; total: number }>) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-[rgba(140,165,220,.16)]"
      role="img"
      aria-label={`${done} of ${total}`}
    >
      <div
        className={`h-1 rounded-full ${done >= total ? "bg-nb-good" : "bg-nb-warn"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** The step an operator is on. One per screen. */
export function OpenStep({ row, n }: Readonly<{ row: ChecklistRow; n: number }>) {
  const { task } = row;
  const unreadable = row.state === "unknown";
  return (
    <li
      aria-label={task.label}
      aria-current="step"
      className="flex gap-4 rounded-[14px] border border-nb-blue/35 bg-[linear-gradient(180deg,rgba(18,32,68,.85),rgba(10,18,44,.7))] px-4 py-4"
    >
      <div className="flex flex-none flex-col items-center gap-2">
        <Marker state={row.state} n={n} open />
        <span className="w-px flex-1 bg-[linear-gradient(180deg,rgba(78,163,255,.45),rgba(140,165,220,.08))]" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[1.3px]">
          <span className="text-nb-blueb">
            {task.gate ? `gate ${task.gate}` : "input"} · {task.short.toLowerCase()}
          </span>
          <span className="h-[3px] w-[3px] rounded-full bg-nb-faint" />
          <span className="text-nb-soft">{unreadable ? "cannot be read" : "do this one next"}</span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[19px] font-semibold tracking-[-.2px] text-nb-ink">{task.label}</h2>
          <span className="font-mono text-[12.5px] text-nb-soft">{row.count}</span>
        </div>

        <p className="mt-2 max-w-[62ch] text-[12.5px] leading-[1.6] text-nb-soft">
          <span className="text-nb-ink">{task.asks}</span> {task.explains}
        </p>

        {/* Why the read could not answer, or what a green tick here does not mean. */}
        {(row.why || row.note) && (
          <p className="mt-1.5 max-w-[62ch] text-[11.5px] leading-[1.55] text-nb-warn">
            {row.why || row.note}
          </p>
        )}

        {row.progress && (
          <div className="mt-3 flex items-center gap-3">
            <div className="max-w-[320px] flex-1">
              <Bar {...row.progress} />
            </div>
            <span className="font-mono text-[11px] text-nb-muted">
              {row.progress.done} / {row.progress.total}
            </span>
          </div>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            href={row.href}
            className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-nb-blue px-5 text-[13px] font-semibold text-white transition hover:bg-nb-blueb"
          >
            {task.cta}
            <Icon icon="heroicons-outline:arrow-right" className="text-[15px]" />
          </Link>
          <span className="text-[11.5px] text-nb-muted">
            frees <span className="text-nb-soft">{task.unlocks.join(" · ")}</span>
          </span>
        </div>
      </div>
    </li>
  );
}

/** Every other step: one line, and enough of it to know what it is about. */
export function QuietStep({
  row,
  n,
  last,
}: Readonly<{ row: ChecklistRow; n: number; last: boolean }>) {
  const st = STATE_STYLE[row.state];
  return (
    <li aria-label={row.task.label} className="flex gap-4">
      <div className="flex flex-none flex-col items-center">
        <span className="h-2 w-px bg-nb-line" />
        <Marker state={row.state} n={n} open={false} />
        {!last && <span className="w-px flex-1 bg-nb-line" />}
      </div>

      <div
        className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 ${
          last ? "" : "border-b border-nb-line"
        }`}
      >
        <div className="min-w-0 basis-[190px]">
          <div className="truncate text-[13px] font-semibold text-nb-ink">{row.task.label}</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[1.2px] text-nb-faint">
            {row.task.gate ? `gate ${row.task.gate}` : "input"}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-nb-muted" title={row.why}>
            {row.task.asks}
          </div>
          {row.progress ? (
            <div className="mt-1.5 max-w-[260px]">
              <Bar {...row.progress} />
            </div>
          ) : (
            <div className="mt-0.5 truncate font-mono text-[11px] text-nb-soft">{row.count}</div>
          )}
          {/* A qualifier on the state belongs wherever the state is shown: a
              green tick an operator cannot read the caveat of is a lie by
              omission, open step or not. */}
          {row.note && <div className="mt-1 text-[11px] leading-[1.5] text-nb-warn">{row.note}</div>}
        </div>

        <span className="hidden flex-none font-mono text-[11px] text-nb-soft sm:block">
          {row.progress ? `${row.progress.done} / ${row.progress.total}` : ""}
        </span>

        <span
          data-state={row.state}
          className={`flex flex-none items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] ${st.cls}`}
        >
          <Icon icon={st.icon} className="text-[12px]" />
          {row.stateLabel}
        </span>

        <Link
          href={row.href}
          className="flex-none rounded-[6px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
        >
          Open →
        </Link>
      </div>
    </li>
  );
}
