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
// * The number formatter is `fmtValue`, which never appends a unit — there is
//   none on the wire (pipeline contract §11/§12).
// * `max-w-[1px] truncate` on the text cells so a long device tag cannot force
//   the table wider than its widget.

import { fmtValue } from "../spec";
import type { Cell, ChartProps } from "./types";

export default function DataTable({ data, options }: ChartProps) {
  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const decimals = options?.decimals;

  function renderCell(cell: Cell): string {
    // null is NOT zero — see the header.
    if (cell === null || cell === undefined) return "—";
    if (typeof cell === "number") return fmtValue(cell, decimals);
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
              <th
                key={`${col}-${i}`}
                className={`truncate px-2.5 py-1.5 font-semibold ${
                  i === data.labelIndex ? "text-left" : "text-right"
                }`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-nb-line/40 hover:bg-[rgba(150,180,245,.06)]">
              {columns.map((_, ci) => {
                const cell = row[ci];
                const numeric = typeof cell === "number";
                return (
                  <td
                    key={`c-${ci}`}
                    className={`truncate px-2.5 py-1.5 ${
                      numeric ? "text-right font-mono text-nb-ink" : "text-nb-soft"
                    }`}
                    title={cell === null || cell === undefined ? "" : String(cell)}
                  >
                    {renderCell(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
