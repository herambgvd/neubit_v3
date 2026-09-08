/**
 * The tab strip. Its one job at runtime is to hand back the KEY of the tab that
 * was clicked; its one job at compile time is to keep that key narrow, so a
 * screen's `setTab` (typed to its own union) cannot be handed a stray string.
 * The `expectTypeOf` below fails the typecheck rather than the run — which is
 * where a lost generic would show up.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { TabBar, type TabBarProps } from "./TabBar";

type Tab = "overview" | "events" | "storage";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "events", label: "Events" },
  { key: "storage", label: "Storage" },
];

describe("TabBar", () => {
  it("reports the key of the tab that was clicked", async () => {
    const onChange = vi.fn();
    render(<TabBar tabs={TABS} active="overview" onChange={onChange} />);

    await userEvent.click(screen.getByRole("tab", { name: "Events" }));

    expect(onChange).toHaveBeenCalledWith("events");
  });

  it("still reports the active tab when it is clicked again, rather than swallowing it", async () => {
    const onChange = vi.fn();
    render(<TabBar tabs={TABS} active="events" onChange={onChange} />);

    await userEvent.click(screen.getByRole("tab", { name: "Events" }));

    expect(onChange).toHaveBeenCalledWith("events");
  });

  it("renders one control per tab and nothing when there are none", () => {
    const { rerender } = render(<TabBar tabs={TABS} active="overview" onChange={vi.fn()} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);

    rerender(<TabBar active={null} onChange={vi.fn()} />);

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("marks the current tab as selected, not just as coloured differently", () => {
    render(<TabBar tabs={TABS} active="events" onChange={() => {}} />);

    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "false");
  });

  it("renders tabs as buttons, so a tab click never submits the form around it", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <TabBar tabs={TABS} active="overview" onChange={vi.fn()} />
      </form>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Storage" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("narrows the key to the caller's own union, not to `string`", () => {
    expectTypeOf<NonNullable<TabBarProps<Tab>["onChange"]>>().parameter(0).toEqualTypeOf<Tab>();
    expectTypeOf<NonNullable<TabBarProps<Tab>["active"]>>().toEqualTypeOf<Tab>();
  });
});
