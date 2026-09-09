/**
 * The page's controls belong in the top bar — and must never simply vanish when
 * no top bar is there to take them.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { HeaderSlot, HeaderSlotOutlet } from "@/components/shell/HeaderSlot";

describe("HeaderSlot", () => {
  it("renders the page's controls inside the header's outlet", () => {
    render(
      <>
        <header data-testid="bar">
          <HeaderSlotOutlet />
        </header>
        <main>
          <HeaderSlot>
            <button type="button">Pause</button>
          </HeaderSlot>
        </main>
      </>,
    );

    const button = screen.getByRole("button", { name: "Pause" });
    expect(screen.getByTestId("bar")).toContainElement(button);
  });

  it("renders them in place when there is no outlet", () => {
    // A unit test rendering a page on its own, or a shell with no header. A
    // control that quietly disappears is worse than one in the wrong place.
    render(
      <HeaderSlot>
        <button type="button">Pause</button>
      </HeaderSlot>,
    );

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});
