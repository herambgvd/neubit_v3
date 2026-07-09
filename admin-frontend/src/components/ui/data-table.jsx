"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { Skeleton } from "./skeleton";
import { EmptyState } from "./empty-state";

/**
 * Reusable data table built on TanStack Table.
 *
 * Props:
 *  - columns: TanStack ColumnDef[] (use `enableSorting: false` to disable a header)
 *  - data: row array
 *  - loading / error: state flags
 *  - onRowClick(row): optional row click handler
 *  - empty: { icon, title, description, action } for the zero state
 *  - manualPagination: when true, renders the footer using the `pagination` prop
 *  - pagination: { page, pages, total, onPrev, onNext, isFetching, label }
 *  - toolbar: node rendered above the table (search/filters)
 */
export function DataTable({
  columns,
  data = [],
  loading = false,
  error = null,
  onRowClick,
  empty,
  toolbar,
  pagination,
  sorting: controlledSorting,
  onSortingChange,
  className,
}) {
  const [internalSorting, setInternalSorting] = useState([]);
  const sorting = controlledSorting ?? internalSorting;

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: onSortingChange ?? setInternalSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
  });

  const colCount = columns.length;
  const rows = table.getRowModel().rows;

  return (
    <div className={className}>
      {toolbar && <div className="mb-4">{toolbar}</div>}

      <div className="overflow-hidden rounded-2xl border border-card-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-card-border text-xs uppercase tracking-wide text-muted">
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <th key={header.id} className="px-5 py-3 font-medium">
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1.5 transition hover:text-foreground"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-50" />
                            )}
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
              {loading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-card-border last:border-0">
                    {Array.from({ length: colCount }).map((__, j) => (
                      <td key={j} className="px-5 py-4">
                        <Skeleton className="h-3.5 w-full max-w-[120px]" />
                      </td>
                    ))}
                  </tr>
                ))}

              {!loading && error && (
                <tr>
                  <td colSpan={colCount} className="px-5 py-10 text-center text-sm text-danger">
                    {typeof error === "string" ? error : "Failed to load data"}
                  </td>
                </tr>
              )}

              {!loading && !error && rows.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="p-0">
                    <EmptyState {...(empty || { title: "No data" })} />
                  </td>
                </tr>
              )}

              {!loading &&
                !error &&
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(
                      "border-b border-card-border last:border-0 transition",
                      onRowClick && "cursor-pointer hover:bg-hover"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-5 py-3.5 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {pagination && (
        <div className="mt-4 flex items-center justify-between text-xs text-muted">
          <span>
            {pagination.label}
            {pagination.isFetching ? " · updating…" : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={pagination.onPrev}
              disabled={pagination.page <= 1}
              className="inline-flex items-center gap-1 rounded-lg border border-card-border bg-card px-2.5 py-1.5 transition hover:border-muted disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <span className="tabular-nums">
              Page {pagination.page} / {pagination.pages}
            </span>
            <button
              onClick={pagination.onNext}
              disabled={pagination.page >= pagination.pages}
              className="inline-flex items-center gap-1 rounded-lg border border-card-border bg-card px-2.5 py-1.5 transition hover:border-muted disabled:opacity-40"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
