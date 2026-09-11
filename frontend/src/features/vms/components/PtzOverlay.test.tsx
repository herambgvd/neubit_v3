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
import { describe, expect, it } from "vitest";

import { isTouring, tourState } from "./PtzOverlay";

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
