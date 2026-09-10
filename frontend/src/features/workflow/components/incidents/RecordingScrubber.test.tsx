/**
 * THE TRANSPORT under the case page's recording.
 *
 * Two things it draws that a plain slider would not, and both are why it exists:
 * WHERE THE EVENT IS in a window that is mostly aftermath, and WHERE THE RECORDER
 * ACTUALLY HAS FOOTAGE. On an estate that does not record every camera, a bar
 * that hides the hole makes "nothing was recorded" look exactly like "nothing
 * happened".
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createClock } from "@/features/vms/hooks/useWallPlayback";
import RecordingScrubber, { offsetLabel, rangeBand } from "./RecordingScrubber";

const FROM = Date.parse("2026-09-10T12:00:00Z");
const EVENT = FROM + 8_000;
const TO = EVENT + 60_000;

function setup(over: Record<string, unknown> = {}) {
  const onSeek = vi.fn();
  const clock = createClock();
  clock.set(EVENT);
  render(
    <RecordingScrubber
      fromMs={FROM}
      toMs={TO}
      eventMs={EVENT}
      clock={clock}
      playing
      speed={1}
      onSeek={onSeek}
      onPlayingChange={vi.fn()}
      onSpeedChange={vi.fn()}
      {...over}
    />,
  );
  return { onSeek, clock };
}

describe("the coverage bands", () => {
  it("clips a range to the window rather than overflowing the bar", () => {
    // The recorder answers about whole segments; one can start before the window
    // and run past its end.
    const band = rangeBand(
      { start: new Date(FROM - 30_000).toISOString(), duration: 200 },
      FROM,
      TO,
    );
    expect(band).toEqual({ left: 0, width: 100 });
  });

  it("drops a range that does not touch the window at all", () => {
    expect(
      rangeBand({ start: new Date(TO + 60_000).toISOString(), duration: 10 }, FROM, TO),
    ).toBeNull();
  });

  it("says the recorder holds nothing, rather than showing a bar that looks unloaded", () => {
    setup({ ranges: [{ start: new Date(TO + 60_000).toISOString(), duration: 10 }] });
    expect(screen.getByText(/holds no footage in this window/i)).toBeInTheDocument();
  });
});

describe("the transport", () => {
  it("seeks ten seconds back from where the video actually is", async () => {
    // From the CLOCK the tile publishes, not from a timer of its own — two clocks
    // would drift and the bar would stop describing the picture.
    const { onSeek, clock } = setup();
    clock.set(EVENT + 30_000);
    await userEvent.click(screen.getByRole("button", { name: /back ten seconds/i }));
    expect(onSeek).toHaveBeenCalledWith(EVENT + 20_000);
  });

  it("stops at the start of the window rather than seeking before it", async () => {
    // The run-up is eight seconds; ten seconds back from the event is outside the
    // window, and a session anchored before it has nothing to play.
    const { onSeek } = setup();
    await userEvent.click(screen.getByRole("button", { name: /back ten seconds/i }));
    expect(onSeek).toHaveBeenCalledWith(FROM);
  });

  it("takes the operator back to the moment it fired", async () => {
    const { onSeek } = setup();
    await userEvent.click(screen.getByRole("button", { name: /event/i }));
    expect(onSeek).toHaveBeenCalledWith(EVENT);
  });

  it("never seeks outside the window", async () => {
    const { onSeek, clock } = setup();
    clock.set(TO);
    await userEvent.click(screen.getByRole("button", { name: /forward ten seconds/i }));
    expect(onSeek).toHaveBeenCalledWith(TO);
  });

  it("counts from the start of the window, not off the wall clock", () => {
    // "18 seconds in" is what an operator reads; a wall-clock time is a
    // subtraction they have to do themselves.
    expect(offsetLabel(EVENT, FROM)).toBe("00:08");
    expect(offsetLabel(TO, FROM)).toBe("01:08");
  });
});
