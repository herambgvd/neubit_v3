/**
 * A KEYBOARD ROUTE IS NOT OPTIONAL, AND ENTER IS ONLY HALF OF IT.
 *
 * Enter is what a sighted tester presses, so an implementation that handles only
 * Enter passes a manual check and still fails the person it was written for: a
 * screen-reader user reaching a role="button" presses SPACE.
 *
 * And the role without the tab stop is the worst of both — it announces itself as
 * a button to a screen reader that can never focus it.
 */
import { describe, expect, it, vi } from "vitest";

import { asButton, onActivate } from "./a11y";

function press(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
}

describe("activating a non-button", () => {
  it("fires on Enter", () => {
    const fn = vi.fn();
    onActivate(fn)!(press("Enter"));
    expect(fn).toHaveBeenCalled();
  });

  it("fires on Space, which is the half that gets forgotten", () => {
    const fn = vi.fn();
    onActivate(fn)!(press(" "));
    expect(fn).toHaveBeenCalled();
  });

  it("prevents the default, or Space scrolls the page as well", () => {
    const e = press(" ");
    onActivate(vi.fn())!(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("ignores every other key", () => {
    const fn = vi.fn();
    for (const k of ["a", "Tab", "Escape", "ArrowDown"]) onActivate(fn)!(press(k));
    expect(fn).not.toHaveBeenCalled();
  });

  it("has no handler at all when there is nothing to activate", () => {
    expect(onActivate(undefined)).toBeUndefined();
  });
});

describe("the whole button contract", () => {
  it("gives a tab stop with the role, never one without the other", () => {
    // role="button" on an element that cannot be focused announces an affordance
    // that does not exist.
    const props = asButton(vi.fn());
    expect(props.role).toBe("button");
    expect(props.tabIndex).toBe(0);
    expect(props.onKeyDown).toBeTypeOf("function");
  });

  it("adds nothing when the element is not interactive", () => {
    // A disabled card must not become a tab stop that does nothing.
    expect(asButton(undefined)).toEqual({});
  });
});
