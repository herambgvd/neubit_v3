// A tile reads LIVE only once a frame is decoded, not when the track is negotiated.
import { describe, expect, it, vi } from "vitest";

import { onFirstPicture } from "./LivePlayer";

function video(readyState = 0) {
  const v = document.createElement("video");
  Object.defineProperty(v, "readyState", { value: readyState });
  return v;
}

describe("onFirstPicture", () => {
  it("waits for the first decoded frame", () => {
    const v = video();
    const done = vi.fn();

    onFirstPicture(v, done);
    expect(done).not.toHaveBeenCalled();

    v.dispatchEvent(new Event("loadeddata"));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("answers at once when a frame is already there", () => {
    const done = vi.fn();
    onFirstPicture(video(2), done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the player is torn down", () => {
    const v = video();
    const done = vi.fn();

    onFirstPicture(v, done)();
    v.dispatchEvent(new Event("loadeddata"));

    expect(done).not.toHaveBeenCalled();
  });
});
