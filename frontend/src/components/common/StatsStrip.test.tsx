/**
 * The clickable count tiles above a filtered list. Two properties: the tile
 * reports its own key (including the empty-string "All" key, which is what makes
 * the filter clearable), and a count that hasn't arrived yet reads as 0 rather
 * than blank.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { StatsStrip, type StatsStripProps } from "./StatsStrip";

type Status = "" | "active" | "closed";

const STATS: { key: Status; label: string; count?: number | null }[] = [
  { key: "", label: "Total", count: 42 },
  { key: "active", label: "Active", count: 5 },
  { key: "closed", label: "Closed", count: null },
];

describe("StatsStrip", () => {
  it("reports the key of the tile that was clicked", async () => {
    const onSelect = vi.fn();
    render(<StatsStrip stats={STATS} active="" onSelect={onSelect} />);

    await userEvent.click(screen.getByText("Active"));

    expect(onSelect).toHaveBeenCalledWith("active");
  });

  it("reports the empty key for the `all` tile, which is how the filter gets cleared", async () => {
    const onSelect = vi.fn();
    render(<StatsStrip stats={STATS} active="active" onSelect={onSelect} />);

    await userEvent.click(screen.getByText("Total"));

    expect(onSelect).toHaveBeenCalledWith("");
  });

  it("shows 0 for a count that is null or missing, never a blank tile", () => {
    render(<StatsStrip stats={STATS} active="" onSelect={vi.fn()} />);

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders one tile per stat and nothing when there are none", () => {
    const { rerender } = render(<StatsStrip stats={STATS} active="" onSelect={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);

    rerender(<StatsStrip active={null} onSelect={vi.fn()} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("narrows the key to the caller's own union, not to `string`", () => {
    expectTypeOf<NonNullable<StatsStripProps<Status>["onSelect"]>>().parameter(0).toEqualTypeOf<Status>();
  });
});
