import type { ColumnDef } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DataTable } from "@/components/ui/data-table";

interface Row {
  id: string;
  name: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name", cell: ({ row }) => row.original.name },
  { accessorKey: "id", header: "Id", enableSorting: false },
];

const rows: Row[] = [
  { id: "t1", name: "Acme" },
  { id: "t2", name: "Globex" },
];

describe("DataTable", () => {
  it("renders one row per record", () => {
    render(<DataTable columns={columns} data={rows} />);

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
  });

  it("shows the empty state instead of rows when there is no data", () => {
    render(<DataTable columns={columns} data={[]} empty={{ title: "No tenants yet" }} />);

    expect(screen.getByText("No tenants yet")).toBeInTheDocument();
  });

  it("shows the error text and NOT the empty state when the load failed", () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        error="Failed to load tenants"
        empty={{ title: "No tenants yet" }}
      />
    );

    expect(screen.getByText("Failed to load tenants")).toBeInTheDocument();
    // A failed load is not an empty result — saying "no tenants" would be a lie.
    expect(screen.queryByText("No tenants yet")).not.toBeInTheDocument();
  });

  it("shows neither rows nor the empty state while loading", () => {
    render(<DataTable columns={columns} data={[]} loading empty={{ title: "No tenants yet" }} />);

    expect(screen.queryByText("No tenants yet")).not.toBeInTheDocument();
  });

  it("calls onRowClick with the row's own record", async () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} data={rows} onRowClick={onRowClick} />);

    await userEvent.click(screen.getByText("Globex"));

    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });

  it("disables paging at both ends of the range", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <DataTable
        columns={columns}
        data={rows}
        pagination={{ page: 1, pages: 3, onPrev, onNext, label: "57 tenants" }}
      />
    );

    expect(screen.getByRole("button", { name: /prev/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeEnabled();
    expect(screen.getByText("57 tenants")).toBeInTheDocument();

    rerender(
      <DataTable
        columns={columns}
        data={rows}
        pagination={{ page: 3, pages: 3, onPrev, onNext, label: "57 tenants" }}
      />
    );

    expect(screen.getByRole("button", { name: /prev/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("sorts on a sortable header and leaves the others alone", async () => {
    render(<DataTable columns={columns} data={rows} />);

    // "Name" is sortable, so its header is a button; "Id" opts out.
    expect(screen.getByRole("button", { name: /name/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^id$/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /name/i }));

    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    expect(cells[0]).toBe("Acme");
  });
});
