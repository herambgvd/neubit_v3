/**
 * CLEARING A BURST.
 *
 * One camera tampered with raises one toast. A recorder losing its uplink raises
 * one PER CHANNEL, and sonner shows three at a time — so an operator who
 * dismisses the three in front is handed three more, and the only way out of a
 * twelve-camera burst is twelve clicks.
 *
 * What is pinned here: the control exists, it appears exactly once (on the toast
 * nearest the corner, which is the one being looked at), it counts the alarms the
 * operator CANNOT see as well as the ones they can, and it does not appear at all
 * for a single alarm — where "clear all" is just a second dismiss button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import LiveEventToast from "./LiveEventToast";
import { liveToastIds, registerToast, resetToasts } from "../liveToasts";

const dismissed: string[] = [];
vi.mock("sonner", () => ({
  toast: { dismiss: (id: string) => dismissed.push(id) },
}));

const EVENT = {
  id: "e1",
  event_id: "e1",
  event_type: "tamper",
  severity: "critical",
  occurred_at: new Date().toISOString(),
  camera_id: "cam-1",
} as never;

function renderToast(toastId: string) {
  return render(
    <LiveEventToast
      toastId={toastId}
      event={EVENT}
      cameraName="Channel 1"
      onView={() => {}}
      onDismiss={() => {}}
    />,
  );
}

// Wrapped in act: the registry is a `useSyncExternalStore` source, so emptying
// it re-renders whatever is still mounted.
beforeEach(() => {
  dismissed.length = 0;
  act(() => resetToasts());
});

afterEach(() => act(() => resetToasts()));

describe("the clear-all control", () => {
  it("is not offered when one alarm is up — that is what Dismiss is for", () => {
    registerToast("t1");
    renderToast("t1");
    expect(screen.queryByRole("button", { name: /clear all/i })).toBeNull();
  });

  it("counts the alarms queued behind the three sonner shows", () => {
    // Five channels went dark at once; two of them are not on screen.
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) registerToast(id);
    renderToast("t5"); // the newest — the front of the stack
    expect(screen.getByRole("button", { name: "Clear all (5)" })).toBeTruthy();
  });

  it("appears on the front toast only, so a stack carries one button", () => {
    registerToast("t1");
    registerToast("t2");
    renderToast("t1"); // the older one, behind
    expect(screen.queryByRole("button", { name: /clear all/i })).toBeNull();
  });

  it("dismisses every alarm toast and empties the registry", async () => {
    for (const id of ["t1", "t2", "t3"]) registerToast(id);
    renderToast("t3");
    await userEvent.click(screen.getByRole("button", { name: "Clear all (3)" }));
    expect(dismissed.sort()).toEqual(["t1", "t2", "t3"]);
    // Cleared here and not left to sonner's exit animation, or the count still
    // reads 3 while the stack fades out.
    expect(liveToastIds()).toEqual([]);
  });
});

describe("the registry", () => {
  it("puts the newest alarm at the front", () => {
    registerToast("t1");
    registerToast("t2");
    expect(liveToastIds()[0]).toBe("t2");
  });

  it("does not count one alarm twice", () => {
    registerToast("t1");
    registerToast("t1");
    expect(liveToastIds()).toEqual(["t1"]);
  });
});
