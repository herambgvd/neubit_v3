"use client";

// Reusable data table built on @tanstack/react-table (v8). Matches the shared
// kit Table aesthetic — sharp uppercase header band, hover rows, right-aligned
// numeric columns (tabular-nums) via column meta `align:"right"`. Adds sorting
// (click a sortable header → asc/desc with a caret) and optional row selection
// (header select-all + per-row checkbox column).
//
// Generic on purpose so other VMS tables can adopt it. Props:
//   columns              — TanStack column defs (use meta.align:"right" for numeric)
//   data                 — array of rows
//   getRowId             — (row) => string; stable id for selection/keys
//   onRowClick           — (row) => void; whole-row click
//   emptyState           — node rendered when data is empty
//   initialSorting       — [{ id, desc }]
//   enableRowSelection   — adds the checkbox column
//   rowSelection         — controlled selection map { [rowId]: true }
//   onRowSelectionChange — TanStack updater (setter) for the map
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";
import { Icon } from "@iconify/react";

function SortCaret({ dir }) {
  // dir: "asc" | "desc" | false
  if (!dir) return <Icon icon="heroicons-outline:chevron-up-down" className="text-xs opacity-40" />;
  return (
    <Icon
      icon={dir === "asc" ? "heroicons-outline:chevron-up" : "heroicons-outline:chevron-down"}
      className="text-xs text-foreground"
    />
  );
}

const alignCls = (a) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

export default function DataTable({
  columns,
  data,
  getRowId,
  onRowClick,
  emptyState = null,
  initialSorting = [],
  enableRowSelection = false,
  rowSelection,
  onRowSelectionChange,
}) {
  // Uncontrolled sorting lives here; selection is controlled by the caller when
  // enableRowSelection is set.
  const [sorting, setSorting] = useState(initialSorting);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      ...(enableRowSelection ? { rowSelection: rowSelection ?? {} } : {}),
    },
    onSortingChange: setSorting,
    enableRowSelection,
    onRowSelectionChange,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;

  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card">
      <table className="w-full text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr
              key={hg.id}
              className="border-b border-card-border bg-hover text-left text-[11px] font-semibold uppercase tracking-wide text-muted"
            >
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const align = header.column.columnDef.meta?.align;
                const headCls = header.column.columnDef.meta?.headClassName || "px-4 py-2.5";
                return (
                  <th
                    key={header.id}
                    className={`${headCls} ${alignCls(align)}`}
                    style={header.column.columnDef.meta?.width ? { width: header.column.columnDef.meta.width } : undefined}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground ${
                          align === "right" ? "flex-row-reverse" : ""
                        }`}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <SortCaret dir={header.column.getIsSorted()} />
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={table.getAllLeafColumns().length} className="p-0">
                {emptyState}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={`border-b border-card-border transition last:border-0 hover:bg-hover ${
                  onRowClick ? "cursor-pointer" : ""
                } ${row.getIsSelected() ? "bg-hover" : ""}`}
              >
                {row.getVisibleCells().map((cell) => {
                  const align = cell.column.columnDef.meta?.align;
                  const cellCls = cell.column.columnDef.meta?.cellClassName || "px-4 py-3 text-foreground";
                  return (
                    <td
                      key={cell.id}
                      className={`${cellCls} ${alignCls(align)} ${align === "right" ? "tabular-nums" : ""}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
