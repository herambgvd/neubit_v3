/**
 * THE console's table. It carries the properties every list relies on without
 * restating them — one row per record, the caller's own empty node so "no
 * results" and "load failed" can differ, and a renderer that wins over the raw
 * field — plus the two this one adds over the simple table it replaced: sorting,
 * and a stable row id.
 *
 * Nothing here asserts a colour or a class. A reskin must be free to move every
 * one of them without turning a single case red.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";

import DataTable from "./DataTable";

interface Row {
  id: string;
  name: string;
  count: number;
}

const rows: Row[] = [
  { id: "a", name: "Lobby", count: 2 },
  { id: "b", name: "Dock", count: 7 },
];

const columns: ColumnDef<Row, any>[] = [
  { id: "name", header: "Name", accessorFn: (r) => r.name },
  { id: "count", header: "Count", accessorFn: (r) => r.count, meta: { align: "right" } },
];

const bodyRows = () => within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");

describe("DataTable", () => {
  it("renders exactly one row per record, plus the header", () => {
    render(<DataTable columns={columns} data={rows} />);

    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.getByText("Dock")).toBeInTheDocument();
  });

  it("renders a cell from its accessor when the column declares no cell", () => {
    render(<DataTable columns={columns} data={rows} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("prefers the column's own cell over the accessor's value", () => {
    render(
      <DataTable
        columns={[
          { id: "count", header: "Count", accessorFn: (r) => r.count, cell: ({ row }) => `${row.original.count} cams` },
        ]}
        data={rows}
      />,
    );

    expect(screen.getByText("2 cams")).toBeInTheDocument();
    expect(screen.queryByText("2")).toBeNull();
  });

  it("renders the caller's own empty node, so `no results` and `load failed` can differ", () => {
    render(<DataTable columns={columns} data={[]} emptyState={<p>Could not reach the recorder</p>} />);

    expect(screen.getByText("Could not reach the recorder")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(1); // the one row holding the empty node
  });

  it("sorts on a header click, and reverses on the second", async () => {
    render(<DataTable columns={columns} data={rows} />);

    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(within(bodyRows()[0]).getByText("Dock")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(within(bodyRows()[0]).getByText("Lobby")).toBeInTheDocument();
  });

  it("honours initialSorting, so a table can open on the row that matters", () => {
    render(<DataTable columns={columns} data={rows} initialSorting={[{ id: "count", desc: true }]} />);

    expect(within(bodyRows()[0]).getByText("Dock")).toBeInTheDocument();
  });

  it("offers no sort control on a column that declares none", () => {
    render(
      <DataTable
        columns={[{ id: "name", header: "Name", accessorFn: (r) => r.name, enableSorting: false }]}
        data={rows}
      />,
    );

    expect(screen.queryByRole("button", { name: /Name/ })).toBeNull();
  });

  it("hands the whole row back on a row click", async () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} data={rows} getRowId={(r) => r.id} onRowClick={onRowClick} />);

    await userEvent.click(screen.getByText("Dock"));

    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });
});
