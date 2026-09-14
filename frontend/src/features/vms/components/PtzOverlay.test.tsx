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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import type { FederatedTour } from "../types";
import PtzOverlay, { TourStrip, isTouring, tourState } from "./PtzOverlay";

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

/**
 * THE HOLD-TO-MOVE CONTRACT.
 *
 * Every control on the pad drives a real head through the recorder that owns the
 * camera, and the discipline is the same for all of them: ONE move on press, ONE
 * stop on release, and the stop is not optional. A release that does not send it
 * leaves the camera turning with nothing on the screen saying so — the operator
 * has let go and the head has not.
 *
 * Focus is the trap inside that. It is a different motor on different routes, so
 * a release that sent a PTZ stop for a focus hold would stop nothing and leave
 * the lens driving to its end stop.
 */
const ptz = vi.fn();
const focusMove = vi.fn();
const focusStop = vi.fn();
const presetsList = vi.fn();
const presetSave = vi.fn();
const patrolGet = vi.fn();
const toursList = vi.fn();

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api", () => {
  const api = {
    federation: {
      ptz: (...a: unknown[]) => ptz(...a),
      focus: {
        move: (...a: unknown[]) => focusMove(...a),
        stop: (...a: unknown[]) => focusStop(...a),
      },
      presets: {
        list: (...a: unknown[]) => presetsList(...a),
        save: (...a: unknown[]) => presetSave(...a),
        goto: vi.fn(),
        remove: vi.fn(),
      },
      patrol: { get: (...a: unknown[]) => patrolGet(...a), operate: vi.fn() },
      tours: { list: (...a: unknown[]) => toursList(...a), operate: vi.fn() },
    },
  };
  return { vms: api, default: api };
});

/** jsdom has no PointerEvent, so `fireEvent.pointerDown` builds a plain Event and
 *  drops `button` and `pointerId` with it — the handler then runs against an event
 *  React's synthetic layer fills differently, and a test written the obvious way
 *  asserts nothing. A MouseEvent named "pointerdown" is what React's listener is
 *  actually bound to. `setPointerCapture` is stubbed because jsdom's own throws on
 *  the undefined pointerId such an event carries. */
function hold(el: HTMLElement, type: "pointerdown" | "pointerup" | "pointerleave") {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

beforeEach(() => {
  for (const m of [ptz, focusMove, focusStop, presetsList, presetSave, patrolGet, toursList]) m.mockReset();
  presetsList.mockResolvedValue({ items: [] });
  patrolGet.mockResolvedValue({ enabled: false });
  toursList.mockResolvedValue({ items: [] });
  ptz.mockResolvedValue({});
  focusMove.mockResolvedValue({});
  focusStop.mockResolvedValue({});
  HTMLElement.prototype.setPointerCapture = vi.fn();
});

const overlay = (canControl = true) =>
  renderWithProviders(<PtzOverlay nodeId="rec-a" cameraId="cam-1" canControl={canControl} />);

describe("holding a pad button", () => {
  it("sends exactly one move on the press and one stop on the release", async () => {
    const { getByTitle } = overlay();
    const up = getByTitle("Pan up");

    hold(up, "pointerdown");
    await waitFor(() => expect(ptz).toHaveBeenCalledTimes(1));
    expect(ptz).toHaveBeenCalledWith("rec-a", "cam-1", {
      action: "move",
      mode: "continuous",
      pan: 0,
      tilt: 0.6,
      zoom: 0,
      speed: 0.6,
    });

    hold(up, "pointerup");
    await waitFor(() => expect(ptz).toHaveBeenCalledTimes(2));
    expect(ptz).toHaveBeenLastCalledWith("rec-a", "cam-1", { action: "stop" });
  });

  it("stops the lens and not the head when a focus hold ends", async () => {
    // Focus is a separate motor on separate routes. A PTZ stop here stops
    // nothing, and the lens keeps driving to its end stop.
    const { getByTitle } = overlay();
    const near = getByTitle("Focus near");

    hold(near, "pointerdown");
    await waitFor(() => expect(focusMove).toHaveBeenCalledWith("rec-a", "cam-1", { direction: "near", speed: 0.5 }));

    hold(near, "pointerup");
    await waitFor(() => expect(focusStop).toHaveBeenCalledWith("rec-a", "cam-1"));
    expect(ptz).not.toHaveBeenCalled();
  });

  it("stops a held control when the window loses focus mid-hold", async () => {
    // Alt-tab away with the button down and the pointer-up never arrives. The
    // head would keep turning until somebody came back to the tab.
    const { getByTitle } = overlay();
    hold(getByTitle("Pan right"), "pointerdown");
    await waitFor(() => expect(ptz).toHaveBeenCalledTimes(1));

    fireEvent.blur(window);
    await waitFor(() => expect(ptz).toHaveBeenLastCalledWith("rec-a", "cam-1", { action: "stop" }));
  });

  it("sends nothing at all for a release that never had a press", async () => {
    // Pointer-up, -leave and -cancel all land on the same stop. Firing one per
    // event would put a stop on the wire every time a cursor crossed the pad.
    const { getByTitle } = overlay();
    hold(getByTitle("Pan up"), "pointerleave");
    await waitFor(() => expect(presetsList).toHaveBeenCalled());
    expect(ptz).not.toHaveBeenCalled();
  });
});

describe("what an operator without vms.ptz.control is shown", () => {
  it("offers no control that moves the camera, rather than ones that refuse", async () => {
    // Not disabled — absent. A pad that can only ever 403 is an invitation to
    // press it, and the refusal arrives as a toast long after the gesture.
    const { queryByTitle, getByText } = overlay(false);
    await waitFor(() => expect(presetsList).toHaveBeenCalled());
    expect(queryByTitle("Pan up")).not.toBeInTheDocument();
    expect(queryByTitle("Zoom in")).not.toBeInTheDocument();
    expect(queryByTitle("Focus near")).not.toBeInTheDocument();
    expect(queryByTitle("Save current position as a preset")).not.toBeInTheDocument();
    // The read-only surface is still there: the preset list is a live view.
    expect(getByText("Presets")).toBeInTheDocument();
  });
});

describe("the preset bar", () => {
  it("says a head cannot store presets at all, which is not the same as storing none", async () => {
    // `supported:false` means there is no preset service on this camera. Showing
    // "None saved" invites a save that can only fail.
    presetsList.mockResolvedValue({ items: [], supported: false });
    const { findByText, queryByTitle } = overlay();
    expect(await findByText("Not supported by this camera")).toBeInTheDocument();
    expect(queryByTitle("Save current position as a preset")).not.toBeInTheDocument();
  });

  it("saves the current position under a new name and never against an existing token", async () => {
    // A token would OVERWRITE that preset — silently moving where every other
    // operator's recall of it points.
    presetsList.mockResolvedValue({ items: [{ token: "p1", name: "Gate" }] });
    vi.spyOn(window, "prompt").mockReturnValue("  Loading bay  ");
    const { findByTitle } = overlay();
    fireEvent.click(await findByTitle("Save current position as a preset"));
    await waitFor(() => expect(presetSave).toHaveBeenCalledWith("rec-a", "cam-1", "Loading bay"));
  });

  it("saves nothing when the name prompt is dismissed or left blank", async () => {
    // An unnamed preset is a row nobody can recognise in the bar afterwards.
    presetsList.mockResolvedValue({ items: [] });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("   ");
    const { findByTitle } = overlay();
    fireEvent.click(await findByTitle("Save current position as a preset"));
    expect(presetSave).not.toHaveBeenCalled();

    prompt.mockReturnValue(null);
    fireEvent.click(await findByTitle("Save current position as a preset"));
    expect(presetSave).not.toHaveBeenCalled();
  });
});

describe("the patrol button and the panel behind it", () => {
  it("badges a running PATROL and a running TOUR differently, because they stop differently", async () => {
    // The whole reason both exist on this button. "On" means the recorder is
    // stepping a patrol and Stop here will end it; "Tour" means the camera's own
    // firmware is moving and stopping the patrol would change nothing.
    toursList.mockResolvedValue({ items: [{ token: "t1", name: "Sweep", status: { state: "Touring" } }] });
    patrolGet.mockResolvedValue({ enabled: false, stops: [] });
    const first = overlay();
    expect(await first.findByText("Tour")).toBeInTheDocument();
    expect(first.queryByText("On")).not.toBeInTheDocument();
    first.unmount();

    patrolGet.mockResolvedValue({ enabled: true, stops: [{}, {}] });
    const second = overlay();
    expect(await second.findByText("On")).toBeInTheDocument();
  });

  it("will not offer Start for a patrol the recorder has no stops for", async () => {
    // A Start on an empty patrol reports success and moves nothing, which reads
    // as a camera that ignored the operator.
    patrolGet.mockResolvedValue({ enabled: false, stops: [] });
    const { findByText, getByRole } = overlay();
    fireEvent.click(await findByText("Patrol"));
    expect(await findByText("No stops set")).toBeInTheDocument();
    expect(getByRole("button", { name: /Start/ })).toBeDisabled();
  });

  it("says why a configured patrol cannot run instead of offering to start it", async () => {
    // `runnable:false` is usually a stop whose preset has been deleted off the
    // camera. The recorder's own sentence is what tells the operator which.
    patrolGet.mockResolvedValue({
      enabled: false,
      stops: [{}, {}],
      runnable: false,
      last_error: "Preset p3 is no longer on the camera",
    });
    const { findByText, getByRole } = overlay();
    fireEvent.click(await findByText("Patrol"));
    expect(await findByText("Preset p3 is no longer on the camera")).toBeInTheDocument();
    expect(getByRole("button", { name: /Start/ })).toBeDisabled();
  });

  it("offers Stop, and only Stop, while the patrol is running", async () => {
    patrolGet.mockResolvedValue({ enabled: true, stops: [{}, {}] });
    const { findByText, queryByRole } = overlay();
    fireEvent.click(await findByText("Patrol"));
    expect(await findByText("2 stops")).toBeInTheDocument();
    expect(queryByRole("button", { name: /Start/ })).not.toBeInTheDocument();
    // By text: the pad's centre button is also titled "Stop", and only the
    // panel's carries the word as a label.
    expect(await findByText("Stop")).toBeInTheDocument();
  });
});
