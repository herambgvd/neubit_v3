/**
 * A camera whose RECORDER is down (SCRUM-334). The estate keeps listing it from the
 * copy it kept, marked offline with the reason, and two helpers decide what that
 * means: whether to name the recorder rather than the camera, and whether a wall id
 * missing from the list may be pruned at all.
 */
import { describe, expect, it } from "vitest";

import { ownerUnreachable, recorderDown } from "./constants";

describe("recorderDown", () => {
  it("is true for the reasons the estate gives a down recorder's cameras", () => {
    expect(recorderDown({ status_reason: "recorder_offline" })).toBe(true);
    expect(recorderDown({ status_reason: "recorder_unreachable" })).toBe(true);
  });

  it("is false for a camera that is offline on its own, or has no reason", () => {
    expect(recorderDown({ status_reason: null })).toBe(false);
    expect(recorderDown({})).toBe(false);
    expect(recorderDown(undefined)).toBe(false);
    expect(recorderDown({ status_reason: "camera_unplugged" })).toBe(false);
  });
});

describe("ownerUnreachable", () => {
  const down = new Set(["rec-b"]);

  it("holds back a wall id whose recorder did not answer", () => {
    expect(ownerUnreachable("fed:rec-b:cam-1", down)).toBe(true);
  });

  it("lets a recorder that answered speak for its own cameras", () => {
    expect(ownerUnreachable("fed:rec-a:cam-1", down)).toBe(false);
  });

  it("never applies to a camera this VMS owns itself", () => {
    expect(ownerUnreachable("4b1c-local-id", down)).toBe(false);
    expect(ownerUnreachable("fed:", down)).toBe(false);
  });
});
