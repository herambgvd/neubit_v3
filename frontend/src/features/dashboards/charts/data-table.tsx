"use client";

// Data table.
//
// PORTED from `frontend-next/src/components/charts/data-table.tsx`, and the
// closest to a straight copy of anything here — the structure (a scrolling
// container, a sticky header row, columns driven entirely by `data.columns`, a
// `renderCell` that formats numbers and passes everything else through) is theirs
// and is exactly right.
//
// Changed:
// * **Theme**: navy tokens instead of shadcn's `border` / `muted` / `bg-muted`,
//   and the console's 11.5px body / 10px uppercase header scale.
// * **`renderCell` distinguishes null from zero.** Theirs already prints an em
//   dash for `null`, which is the behaviour this data most needs — it is repeated
//   here deliberately so nobody "tidies" it into `?? 0`. A point with no sample in
//   the window has NO value; showing 0 would invent a reading.
// * The number formatter is the widget's own (`number-format.ts`). It appends a unit ONLY when this widget's author stated one, and the tile attributes it — there is
//   none on the wire (pipeline contract §11/§12).
// * `max-w-[1px] truncate` on the text cells so a long device tag cannot force
//   the table wider than its widget.
// * **A comparison adds a Δ column per measure**, and only when the widget asked
//   for one. The earlier value is put in the cell's title attribute rather than
//   in a column of its own — a tile in a four-column grid cannot afford to double
//   its columns, and the change is the thing being asked for. Where the server
//   could not compute a change (no earlier row for that group, or a previous
//   value of exactly zero) the cell is BLANK, not "0%" and not "—": a dash reads
//   as "we compared and got nothing", and what actually happened is that there
//   was nothing to compare.

import { Fragment } from "react";

import { formatterFor } from "../number-format";
import { fmtDelta } from "./delta";
import type { Cell, ChartProps } from "./types";

export default function DataTable({ data, options }: ChartProps) {
  const columns = data?.columns || [];
  const rows = data?.rows || [];
  // ONE formatter per widget, built from its options, so the axis, the tooltip
  // and any value label cannot spell the same number differently. It appends the
  // author's stated unit when there is one — and the widget footer attributes it
  // (`number-format.unitNote`), because a unit here is a person's claim, never
  // something read from the data (contract §4).
  const fmt = formatterFor(options);

  // Which columns get a Δ beside them: the ones that hold numbers. A dimension
  // column has no change to show, and the server already returns NULL for its
  // delta, so this only decides whether the column exists at all.
  const cmp = data.comparison;
  const deltaCols = cmp
    ? columns.map((_, i) => i !== data.labelIndex && rows.some((r) => typeof r[i] === "number"))
    : columns.map(() => false);

  function renderCell(cell: Cell): string {
    // null is NOT zero — see the header.
    if (cell === null || cell === undefined) return "—";
    if (typeof cell === "number") return fmt(cell);
    return String(cell);
  }

  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[11.5px] text-nb-faint">
        Nothing matched this scope.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {/* `table-fixed w-full`, not their `min-w-full`. Theirs lets the widest
          `whitespace-nowrap` header decide the table width, which is right for a
          full-page result view but wrong inside a 4-column grid tile: the value
          columns simply scrolled out of sight and the widget looked broken.
          Fixed layout makes the columns share the tile, and the cells already
          truncate with the full text in a title attribute. */}
      <table className="w-full table-fixed border-collapse text-[11.5px]">
        <thead className="sticky top-0 z-10 bg-[rgba(11,18,40,.96)]">
          <tr className="text-left text-[10px] uppercase tracking-[1.2px] text-nb-faint">
            {columns.map((col, i) => (
              <Fragment key={`${col}-${i}`}>
                <th
                  className={`truncate px-2.5 py-1.5 font-semibold ${
                    i === data.labelIndex ? "text-left" : "text-right"
                  }`}
                >
                  {col}
                </th>
                {deltaCols[i] ? (
                  <th
                    className="w-[62px] truncate px-2.5 py-1.5 text-right font-semibold"
                    title={cmp ? `change versus ${cmp.label}` : undefined}
                  >
                    Δ
                  </th>
                ) : null}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-nb-line/40 hover:bg-[rgba(150,180,245,.06)]">
              {columns.map((_, ci) => {
                const cell = row[ci];
                const numeric = typeof cell === "number";
                const d = cmp?.deltaPct?.[ri]?.[ci];
                const prev = cmp?.rows?.[ri]?.[ci];
                return (
                  <Fragment key={`c-${ci}`}>
                    <td
                      className={`truncate px-2.5 py-1.5 ${
                        numeric ? "text-right font-mono text-nb-ink" : "text-nb-soft"
                      }`}
                      title={cell === null || cell === undefined ? "" : String(cell)}
                    >
                      {renderCell(cell)}
                    </td>
                    {deltaCols[ci] ? (
                      <td
                        className="truncate px-2.5 py-1.5 text-right font-mono text-nb-soft"
                        title={
                          prev === null || prev === undefined
                            ? `nothing to compare with in ${cmp?.label}`
                            : `${renderCell(prev)} in ${cmp?.label}`
                        }
                      >
                        {typeof d === "number" && Number.isFinite(d) ? fmtDelta(d) : ""}
                      </td>
                    ) : null}
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
