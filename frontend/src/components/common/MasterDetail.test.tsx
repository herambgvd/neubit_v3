/**
 * The two-pane list/detail scaffold. It is presentational, so what is pinned is
 * the composition contract the four screens built on it depend on: both panes
 * always render, the search box exists only when someone is listening for it,
 * and a count of 0 is shown rather than hidden.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EmptyDetail, ListPanel, MasterDetail } from "./MasterDetail";

describe("MasterDetail", () => {
  it("renders both panes, aside and detail", () => {
    render(
      <MasterDetail aside={<p>List</p>}>
        <p>Detail</p>
      </MasterDetail>,
    );

    expect(screen.getByText("List")).toBeInTheDocument();
    expect(screen.getByText("Detail")).toBeInTheDocument();
  });

  it("keeps the detail pane rendered in the internally-scrolling `fill` layout too", () => {
    render(
      <MasterDetail fill aside={<p>List</p>}>
        <p>Detail</p>
      </MasterDetail>,
    );

    expect(screen.getByText("List")).toBeInTheDocument();
    expect(screen.getByText("Detail")).toBeInTheDocument();
  });
});

describe("ListPanel", () => {
  it("shows a search box only when the caller is listening for a query", () => {
    const { rerender } = render(<ListPanel title="Sites">rows</ListPanel>);
    expect(screen.queryByRole("textbox")).toBeNull();

    rerender(
      <ListPanel title="Sites" search="" onSearch={vi.fn()}>
        rows
      </ListPanel>,
    );

    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("reports what was typed, not the event", async () => {
    const onSearch = vi.fn();
    render(
      <ListPanel title="Sites" search="" onSearch={onSearch}>
        rows
      </ListPanel>,
    );

    await userEvent.type(screen.getByRole("textbox"), "h");

    expect(onSearch).toHaveBeenCalledWith("h");
  });

  it("shows a count of 0 but hides the badge entirely when there is no count to show", () => {
    const { rerender } = render(
      <ListPanel title="Sites" count={0}>
        rows
      </ListPanel>,
    );
    expect(screen.getByText("0")).toBeInTheDocument();

    rerender(<ListPanel title="Sites">rows</ListPanel>);

    expect(screen.queryByText("0")).toBeNull();
  });

  it("renders its rows and its header action", () => {
    render(
      <ListPanel title="Sites" action={<button type="button">New</button>}>
        <p>Row one</p>
      </ListPanel>,
    );

    expect(screen.getByText("Row one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});

describe("EmptyDetail", () => {
  it("says why the pane is blank instead of leaving it blank", () => {
    render(<EmptyDetail title="No site selected" subtitle="Pick one from the list" />);

    expect(screen.getByText("No site selected")).toBeInTheDocument();
    expect(screen.getByText("Pick one from the list")).toBeInTheDocument();
  });

  it("still says something when the caller supplies no copy", () => {
    render(<EmptyDetail />);

    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
  });
});
