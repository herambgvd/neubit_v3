// KEYBOARD ROUTES TO THINGS THAT ARE ALREADY CLICKABLE.
//
// A div with an onClick is invisible to a keyboard. Not "harder to reach" —
// invisible: there is no tab stop, so the action does not exist for anyone not
// using a pointer. In this console that included resetting a user's MFA and
// picking a camera onto the video wall.
//
// The right fix is almost always a real <button>, and where the markup allows it
// that is what was done. These helpers are for the places it does not: a drop
// target that is also clickable, a grid cell that must stay a div for layout. They
// give the element the three things a button has and it lacks — a tab stop, a role
// a screen reader announces, and activation on Enter and Space.
//
// SPACE IS THE HALF PEOPLE FORGET. Enter alone feels like it works, because Enter
// is what a tester tries; a screen-reader user reaching a role="button" presses
// Space and nothing happens. Space also scrolls the page by default, so it has to
// be prevented — which is exactly why a native <button> is better when it is an
// option.
import type { KeyboardEvent } from "react";

/** Activation keys for role="button", per WAI-ARIA. */
export function onActivate<T extends Element>(
  fn: (() => void) | undefined,
): ((e: KeyboardEvent<T>) => void) | undefined {
  if (!fn) return undefined;
  return (e: KeyboardEvent<T>) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    // Space scrolls, Enter can submit a surrounding form. Neither is what the
    // operator asked for by pressing a button.
    e.preventDefault();
    fn();
  };
}

/** The whole set of props a non-button element needs to behave like one. Spread
 *  it, so a site cannot acquire the role without also acquiring the tab stop —
 *  which is the combination that looks accessible and is not. */
export function asButton<T extends Element>(fn: (() => void) | undefined, label?: string) {
  if (!fn) return {};
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: fn,
    onKeyDown: onActivate<T>(fn),
  };
}
