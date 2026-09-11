/**
 * A CAMERA TOUR IS NOT THE RECORDER'S PATROL.
 *
 * The same camera can carry both: a patrol the recorder steps, and a preset tour
 * stored in the camera's own firmware. They do not know about each other, and a
 * console that merged them into one "patrol" control would have to pick one to
 * report — which is how somebody stops a patrol and watches the head keep moving.
 *
 * Because a tour survives the tab that started it, the DEVICE's reported state is
 * the only honest answer to whether one is running. Anything this console
 * remembered about having started one would be its own history read back.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FederatedTour } from "../types";
import { TourStrip, isTouring, tourState } from "./PtzOverlay";

describe("whether a tour is running", () => {
  it("believes the device when it says it is touring", () => {
    expect(isTouring({ token: "t1", status: { state: "Touring" } })).toBe(true);
  });

  it("does not call a paused tour running", () => {
    // Paused is one of the four ONVIF states and it is not motion. Treating it as
    // running would offer "Stop" for a head that is already still, and hide the
    // Start that would actually resume it.
    expect(isTouring({ token: "t1", status: { state: "Paused" } })).toBe(false);
    expect(isTouring({ token: "t1", status: { state: "Idle" } })).toBe(false);
  });

  it("says not running when the device said nothing", () => {
    expect(isTouring({ token: "t1" })).toBe(false);
    expect(isTouring({ token: "t1", status: null })).toBe(false);
  });
});

describe("what the device says it is doing", () => {
  it("passes the device's own word through", () => {
    // Idle | Touring | Paused | Extended are the schema's. Re-spelling them into a
    // vocabulary of ours would mean inventing a fifth state at the first surprise.
    for (const state of ["Idle", "Touring", "Paused", "Extended"]) {
      expect(tourState({ token: "t1", status: { state } })).toBe(state);
    }
  });

  it("falls back to Idle rather than blank when nothing was reported", () => {
    expect(tourState({ token: "t1" })).toBe("Idle");
  });
});

describe("the tour strip", () => {
  const tours: FederatedTour[] = [
    { token: "t1", name: "Perimeter sweep", status: { state: "Touring" } },
    { token: "t2", name: "", status: { state: "Idle" } },
  ];

  it("offers Stop for the tour that is running and Start for the one that is not", async () => {
    const onOperate = vi.fn();
    render(<TourStrip tours={tours} canControl onOperate={onOperate} />);

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onOperate).toHaveBeenCalledWith("t1", "Stop");

    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onOperate).toHaveBeenCalledWith("t2", "Start");
  });

  it("names an unnamed tour by its token rather than showing a blank row", () => {
    render(<TourStrip tours={tours} canControl={false} onOperate={vi.fn()} />);
    expect(screen.getByText("Perimeter sweep")).toBeInTheDocument();
    expect(screen.getByText("t2")).toBeInTheDocument();
  });

  it("shows the device's state next to each tour", () => {
    render(<TourStrip tours={tours} canControl={false} onOperate={vi.fn()} />);
    expect(screen.getByText("Touring")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("shows no buttons at all without vms.ptz.control", () => {
    // Not disabled buttons — absent. A control that can only ever refuse is an
    // invitation to press it, and the refusal arrives as a toast minutes later.
    render(<TourStrip tours={tours} canControl={false} onOperate={vi.fn()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("says these outlive the window, because that is the whole difference", () => {
    // A recorder patrol stops when the recorder stops it. A camera tour is in the
    // camera's firmware and keeps going after this tab closes — an operator who
    // thinks they stopped the movement by closing the console is wrong.
    render(<TourStrip tours={tours} canControl onOperate={vi.fn()} />);
    expect(screen.getByText(/keep running after this window closes/)).toBeInTheDocument();
  });
});
