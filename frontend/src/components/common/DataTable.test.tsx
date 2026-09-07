/**
 * The TanStack-backed table every list screen renders through.
 *
 * The property that matters most here is the one about the EMPTY SLOT. This table
 * has no loading or error state of its own — it renders whatever node the caller
 * puts in `emptyState`. That is deliberate, and it is only safe as long as the
 * slot is rendered verbatim: a screen that has failed to load passes an error
 * node into it, and the table must show that error rather than substituting some
 * built-in "no data" of its own. A failed load reporting "no cameras" is the bug
 * these tests exist to prevent.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import DataTable from "./DataTable";

interface Camera {
  id: string;
  name: string;
  count: number;
}

const DATA: Camera[] = [
  { id: "a", name: "Lobby", count: 7 },
  { id: "b", name: "Dock", count: 2 },
  { id: "c", name: "Roof", count: 5 },
];

const columns: ColumnDef<Camera, string | number>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "count", header: "Count", meta: { align: "right" } },
];

/** Body rows only — the header group is a row too. */
const bodyRows = () => screen.getAllByRole("row").slice(1);

describe("DataTable", () => {
  it("renders exactly one row per record", () => {
    render(<DataTable columns={columns} data={DATA} />);

    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.getByText("Roof")).toBeInTheDocument();
  });

  it("renders the caller's empty slot verbatim, so a failed load reports the error and never `no data`", () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        emptyState={<p>Could not reach the recorder</p>}
      />,
    );

    expect(screen.getByText("Could not reach the recorder")).toBeInTheDocument();
    // Nothing of its own: no invented placeholder text competing with the error.
    expect(screen.queryByText(/no data|nothing/i)).toBeNull();
  });

  it("shows a different empty slot for a different reason, because the caller owns it", () => {
    const { rerender } = render(
      <DataTable columns={columns} data={[]} emptyState={<p>Loading cameras…</p>} />,
    );
    expect(screen.getByText("Loading cameras…")).toBeInTheDocument();

    rerender(<DataTable columns={columns} data={[]} emptyState={<p>No cameras yet</p>} />);

    expect(screen.getByText("No cameras yet")).toBeInTheDocument();
    expect(screen.queryByText("Loading cameras…")).toBeNull();
  });

  it("shows no record rows at all while the empty slot is up", () => {
    render(<DataTable columns={columns} data={[]} emptyState={<p>Load failed</p>} />);

    // One body row, and it is the slot — not a record.
    expect(bodyRows()).toHaveLength(1);
    expect(screen.queryByText("Lobby")).toBeNull();
  });

  it("hands the row's own object to onRowClick, not an index or an id", async () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} data={DATA} onRowClick={onRowClick} />);

    await userEvent.click(screen.getByText("Dock"));

    expect(onRowClick).toHaveBeenCalledWith(DATA[1]);
  });

  it("sorts the rows it displays when a sortable header is clicked", async () => {
    render(<DataTable columns={columns} data={DATA} />);
    expect(bodyRows()[0]).toHaveTextContent("Lobby");

    await userEvent.click(screen.getByRole("button", { name: /name/i }));

    expect(bodyRows()[0]).toHaveTextContent("Dock");

    await userEvent.click(screen.getByRole("button", { name: /name/i }));

    expect(bodyRows()[0]).toHaveTextContent("Roof");
  });

  it("starts in the order the caller asked for", () => {
    render(<DataTable columns={columns} data={DATA} initialSorting={[{ id: "count", desc: true }]} />);

    expect(bodyRows()[0]).toHaveTextContent("Lobby");
    expect(bodyRows()[2]).toHaveTextContent("Dock");
  });

  it("offers no sort affordance on a column the caller marked unsortable", () => {
    render(
      <DataTable
        columns={[{ accessorKey: "name", header: "Name", enableSorting: false }]}
        data={DATA}
      />,
    );

    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /name/i })).toBeNull();
  });

  it("renders a column's own cell renderer rather than the raw field", () => {
    render(
      <DataTable
        columns={[
          { accessorKey: "count", header: "Count", cell: (c) => `${c.getValue<number>()} cams` },
        ]}
        data={DATA}
      />,
    );

    expect(screen.getByText("7 cams")).toBeInTheDocument();
    expect(screen.queryByText("7")).toBeNull();
  });
});
