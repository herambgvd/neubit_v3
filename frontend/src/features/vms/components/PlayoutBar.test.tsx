/**
 * Scrubbing the wall's playout track. The track draws a window that is mostly
 * GAP on a motion-recorded estate, so where a click lands is the whole of the
 * control: an operator drags roughly to "about nine this morning" and expects
 * footage, not silence and not a jump backwards into yesterday.
 *
 * TWO HALVES. The derivations first — `seekTargetMs`, `neighbourSpanStart`,
 * `spanRect`, `trackMarker` — each on its own, because each is arithmetic with
 * a rule in it. Then the BAR, rendered: whether the controls are wired to the
 * callbacks their labels promise, whether the label names the camera whose
 * coverage is on the track, and whether a press on the track hands the
 * derivations the instant the operator actually pointed at. The second half is
 * what a correct `seekTargetMs` reached from a mis-measured track would pass.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const timeline = vi.fn();
vi.mock("../api", () => ({ vms: { federation: { timeline: (...a: unknown[]) => timeline(...a) } } }));

import PlayoutBar, {
  neighbourSpanStart,
  seekTargetMs,
  spanRect,
  trackMarker,
  type WallPlayback,
} from "./PlayoutBar";
import { renderWithProviders } from "@/test/render";

const SPANS = [
  { start: 1_000, end: 2_000, trigger: null },
  { start: 5_000, end: 6_000, trigger: "motion" },
];

describe("seekTargetMs", () => {
  it("plays exactly where the operator clicked, inside a recorded span", () => {
    expect(seekTargetMs(1_500, SPANS)).toBe(1_500);
    expect(seekTargetMs(1_000, SPANS)).toBe(1_000);
    expect(seekTargetMs(2_000, SPANS)).toBe(2_000);
  });

  it("snaps forward out of a gap, so a rough drag still lands on footage", () => {
    expect(seekTargetMs(3_000, SPANS)).toBe(5_000);
  });

  it("never snaps backwards", () => {
    // Landing after the last span, the honest answer is "there is nothing here"
    // — which the player then says. Jumping back to earlier footage would show
    // the operator a different moment than the one they asked for.
    expect(seekTargetMs(9_000, SPANS)).toBe(9_000);
    expect(seekTargetMs(9_000, [])).toBe(9_000);
  });
});

describe("neighbourSpanStart", () => {
  it("steps to the next span forwards and the previous one backwards", () => {
    expect(neighbourSpanStart(SPANS, 1_500, 1)).toBe(5_000);
    expect(neighbourSpanStart(SPANS, 5_500, -1)).toBe(1_000);
  });

  it("keeps stepping when the playhead is sitting exactly on a span's start", () => {
    // The repeat case, and the one that made the button look dead: landing on
    // 5_000 and pressing forward again must not find 5_000 "after" the playhead.
    expect(neighbourSpanStart(SPANS, 5_000, 1)).toBeNull();
    expect(neighbourSpanStart(SPANS, 1_000, 1)).toBe(5_000);
  });

  it("says so rather than wrapping around when there is nothing that way", () => {
    expect(neighbourSpanStart(SPANS, 9_000, 1)).toBeNull();
    expect(neighbourSpanStart(SPANS, 0, -1)).toBeNull();
    expect(neighbourSpanStart([], 1_000, 1)).toBeNull();
  });
});

describe("spanRect", () => {
  const FROM = 0;
  const WINDOW = 10_000;

  it("places a span as a percentage of the window on screen", () => {
    expect(spanRect({ start: 1_000, end: 2_000, trigger: null }, FROM, WINDOW)).toEqual({
      left: 10,
      width: 10,
    });
  });

  it("clamps a span to the track rather than painting off either end", () => {
    // A span that started before the window and runs past it — an overnight
    // continuous recording seen through a five-minute lens. Unclamped it would
    // paint over the ticks and the playhead outside the track's own box.
    const r = spanRect({ start: -50_000, end: 60_000, trigger: null }, FROM, WINDOW)!;
    expect(r.left).toBe(0);
    expect(r.width).toBe(100);
  });

  it("never lets real footage round away to nothing", () => {
    // Two seconds on a 24h track. Drawn honestly this is 0.002% — invisible, and
    // an invisible span reads as a gap in footage that exists.
    const r = spanRect({ start: 0, end: 2_000, trigger: null }, 0, 86_400_000)!;
    expect(r.width).toBe(0.15);
  });

  it("draws nothing at all for a span wholly outside the window", () => {
    expect(spanRect({ start: 50_000, end: 60_000, trigger: null }, FROM, WINDOW)).toBeNull();
    expect(spanRect({ start: -50_000, end: -40_000, trigger: null }, FROM, WINDOW)).toBeNull();
  });
});

describe("trackMarker", () => {
  const base = { from: 0, windowMs: 10_000, drag: null, hover: null, playback: false, head: null, nowMs: 7_000 };

  it("follows the pointer while a drag is live, not the playhead", () => {
    // Mid-drag the operator is AIMING. Showing the playhead here would mean the
    // marker ignores the gesture until release.
    const m = trackMarker({ ...base, drag: 0.25, playback: true, head: 9_000 });
    expect(m.markerMs).toBe(2_500);
    expect(m.markerFrac).toBe(0.25);
  });

  it("shows the playhead in playback and the live edge otherwise", () => {
    expect(trackMarker({ ...base, playback: true, head: 3_000 }).markerMs).toBe(3_000);
    expect(trackMarker({ ...base }).markerMs).toBe(7_000);
  });

  it("marks nothing when playback has no playhead yet", () => {
    // Not 0, and not the window's start: parking the marker at the left edge
    // would read as "we are playing the oldest footage in view".
    const m = trackMarker({ ...base, playback: true, head: null });
    expect(m.markerMs).toBeNull();
    expect(m.markerFrac).toBeNull();
  });

  it("reads the hover clock off the pointer, independently of the marker", () => {
    expect(trackMarker({ ...base, hover: 0.5 }).hoverMs).toBe(5_000);
    expect(trackMarker({ ...base }).hoverMs).toBeNull();
  });
});

// A round hour on the track, and a playhead in the middle of it. Everything the
// geometry assertions expect is derived from these two numbers.
const FROM = 1_767_000_000_000;
const SPAN = 3_600_000;
const HEAD = FROM + SPAN / 2;

const CAMERA = {
  id: "fed:recorder-a:cam-1",
  name: "Loading bay",
  node_id: "recorder-a",
  node_name: "Recorder A",
  real_id: "cam-1",
  federated: true,
} as never;

const LOCAL_CAMERA = { id: "cam-9", name: "Lobby", federated: false } as never;

/** A recorded range as the recorder's timeline reports it. */
const range = (offsetMs: number, durationSec: number, trigger = "continuous") => ({
  start: new Date(FROM + offsetMs).toISOString(),
  duration: durationSec,
  trigger_type: trigger,
});

/** The wall DVR handle, with every callback a spy. */
function fakePlayback(over: Partial<WallPlayback> = {}) {
  return {
    win: { fromMs: FROM, toMs: FROM + SPAN },
    mode: "live",
    speed: 1,
    rangeSeconds: 3_600,
    sync: false,
    playing: false,
    isPlayback: false,
    // Publishing a head on subscribe makes span stepping deterministic: the bar
    // steps from the playhead, and an unpublished one falls back to Date.now().
    clock: { subscribe: (fn: (ms: number | null) => void) => { fn(HEAD); return () => {}; } },
    playAt: vi.fn(),
    goLive: vi.fn(),
    skip: vi.fn(),
    setRange: vi.fn(),
    pickDay: vi.fn(),
    pan: vi.fn(),
    setSpeed: vi.fn(),
    toggleSync: vi.fn(),
    togglePlaying: vi.fn(),
    ...over,
  } as unknown as WallPlayback;
}

async function show(pb: WallPlayback, camera: unknown = CAMERA) {
  const view = renderWithProviders(<PlayoutBar camera={camera as never} pb={pb} />);
  // The timeline query is in flight on first paint; wait for it to land so the
  // spans are real before anything is pressed.
  if ((camera as { federated?: boolean })?.federated) {
    await waitFor(() => expect(timeline).toHaveBeenCalled());
  }
  return view;
}

/** The track div — the one element that owns the scrub gesture. */
function track(container: HTMLElement, width = 1000) {
  const el = container.querySelector(".touch-none") as HTMLElement;
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: 0, width, top: 0, height: 40, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  return el;
}

/** A pointer event carrying a real button and clientX.
 *
 *  jsdom has no `PointerEvent`, so `fireEvent.pointerDown` builds a plain Event
 *  and DROPS both — the bar then sees `button === undefined`, returns early, and
 *  a test written the obvious way passes an assertion it never reached. A
 *  MouseEvent typed `pointerdown` is what React's listener is bound to and it
 *  carries the coordinates. */
function pointer(el: HTMLElement, type: string, clientX: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }));
}

/** Press and release at `frac` along the track — one committed seek. */
function scrubTo(el: HTMLElement, frac: number, width = 1000) {
  pointer(el, "pointerdown", frac * width);
  pointer(el, "pointerup", frac * width);
}

beforeEach(() => {
  timeline.mockReset();
  timeline.mockResolvedValue({ ranges: [] });
});

describe("the transport calls back with what it claims", () => {
  it("skips ten seconds each way, in the direction on the button", async () => {
    // The two skips are one sign apart, which is exactly the kind of mistake
    // that survives review and sends the wall the wrong way.
    const pb = fakePlayback({ mode: "playback" } as never);
    await show(pb);
    await userEvent.click(screen.getByTitle("Back 10s"));
    expect(pb.skip).toHaveBeenCalledWith(-10);
    await userEvent.click(screen.getByTitle("Forward 10s"));
    expect(pb.skip).toHaveBeenCalledWith(10);
  });

  it("returns the wall to live, and toggles sync, from their own buttons", async () => {
    const pb = fakePlayback({ mode: "playback" } as never);
    await show(pb);
    await userEvent.click(screen.getByTitle("Return every tile to its live stream"));
    expect(pb.goLive).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTitle(/^Sync/));
    expect(pb.toggleSync).toHaveBeenCalledTimes(1);
    expect(pb.skip).not.toHaveBeenCalled();
  });

  it("plays the earliest footage in view from a live wall, rather than toggling a playback that has not started", async () => {
    // Off live there is no playhead to pause, so Play means "enter playback at
    // the first recorded instant". Toggling instead is a dead button.
    timeline.mockResolvedValue({ ranges: [range(600_000, 300)] });
    const pb = fakePlayback();
    await show(pb);
    await userEvent.click(await screen.findByTitle("Play the earliest footage in view"));
    expect(pb.playAt).toHaveBeenCalledWith(FROM + 600_000);
    expect(pb.togglePlaying).not.toHaveBeenCalled();
  });

  it("pauses rather than re-seeking once the wall is already in playback", async () => {
    timeline.mockResolvedValue({ ranges: [range(600_000, 300)] });
    const pb = fakePlayback({ mode: "playback", playing: true } as never);
    await show(pb);
    await userEvent.click(await screen.findByTitle("Pause"));
    expect(pb.togglePlaying).toHaveBeenCalledTimes(1);
    expect(pb.playAt).not.toHaveBeenCalled();
  });

  it("steps to the neighbouring recorded span, in the direction pressed", async () => {
    // Not "ten seconds that way": the point of the two arrows is to land on
    // footage, which on a sparse timeline is minutes away in either direction.
    timeline.mockResolvedValue({
      ranges: [range(0, 60), range(SPAN / 2 + 600_000, 60)],
    });
    const pb = fakePlayback();
    await show(pb);
    await userEvent.click(await screen.findByTitle("Next recorded span"));
    expect(pb.playAt).toHaveBeenCalledWith(FROM + SPAN / 2 + 600_000);
    await userEvent.click(screen.getByTitle("Previous recorded span"));
    expect(pb.playAt).toHaveBeenLastCalledWith(FROM);
  });

  it("pages the window and picks a range from the ladder", async () => {
    const pb = fakePlayback();
    await show(pb);
    await userEvent.click(screen.getByTitle("Earlier"));
    expect(pb.pan).toHaveBeenCalledWith(-1);
    await userEvent.click(screen.getByTitle("Later"));
    expect(pb.pan).toHaveBeenLastCalledWith(1);
    await userEvent.click(screen.getByRole("button", { name: "12h" }));
    expect(pb.setRange).toHaveBeenCalledWith(43_200);
  });

  it("offers speeds only in playback, where a rate means something", async () => {
    const live = fakePlayback();
    const { unmount } = await show(live);
    expect(screen.queryByRole("button", { name: "2×" })).not.toBeInTheDocument();
    unmount();

    const pb = fakePlayback({ mode: "playback" } as never);
    await show(pb);
    await userEvent.click(screen.getByRole("button", { name: "2×" }));
    expect(pb.setSpeed).toHaveBeenCalledWith(2);
  });

  it("disables every recorder-only control for a camera no recorder owns", async () => {
    // A local camera has no federated timeline. Live buttons over footage that
    // cannot exist invite a press that does nothing and reads as a broken bar.
    await show(fakePlayback(), LOCAL_CAMERA);
    expect(screen.getByTitle("Next recorded span")).toBeDisabled();
    expect(screen.getByTitle("Previous recorded span")).toBeDisabled();
    expect(screen.getByTitle("Play the earliest footage in view")).toBeDisabled();
    expect(timeline).not.toHaveBeenCalled();
    expect(screen.getByText("Recorder playback only")).toBeInTheDocument();
  });
});

describe("the label names the camera on the track", () => {
  it("shows the focused camera and the recorder holding it", async () => {
    timeline.mockResolvedValue({ ranges: [range(0, 60), range(600_000, 60)] });
    await show(fakePlayback());
    expect(screen.getByText("Loading bay")).toBeInTheDocument();
    expect(screen.getByText("· Recorder A")).toBeInTheDocument();
    expect(await screen.findByText("2 spans in view")).toBeInTheDocument();
  });

  it("counts one span in the singular", async () => {
    // A bar reading "1 spans in view" is the tell that nobody looked at it.
    timeline.mockResolvedValue({ ranges: [range(0, 60)] });
    await show(fakePlayback());
    expect(await screen.findByText("1 span in view")).toBeInTheDocument();
  });

  it("asks for a camera rather than labelling an empty track", async () => {
    await show(fakePlayback(), null);
    expect(screen.getByText(/Click a camera on the wall/)).toBeInTheDocument();
    // The em dash, not "Recorder playback only": there is no camera to say it of.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("says the recorder has no footage here rather than drawing a blank track", async () => {
    await show(fakePlayback());
    expect(await screen.findByText("No recorded footage in this window")).toBeInTheDocument();
  });
});

describe("a press on the track seeks where the geometry says", () => {
  it("seeks to the instant under the pointer when it lands on footage", async () => {
    // Half way along an hour-wide track is thirty minutes in. Nothing rounds it
    // to a span's edge, because the operator pointed at an instant.
    timeline.mockResolvedValue({ ranges: [range(0, 3_600)] });
    const pb = fakePlayback();
    const { container } = await show(pb);
    await screen.findByText("1 span in view");
    scrubTo(track(container), 0.5);
    expect(pb.playAt).toHaveBeenCalledWith(FROM + SPAN / 2);
  });

  it("snaps forward to the next span when the press lands in a gap", async () => {
    // A rough drag that lands between recordings should reach footage, not sit
    // in the gap looking like a player that failed to start.
    timeline.mockResolvedValue({ ranges: [range(0, 60), range(3_000_000, 60)] });
    const pb = fakePlayback();
    const { container } = await show(pb);
    await screen.findByText("2 spans in view");
    scrubTo(track(container), 0.5);
    expect(pb.playAt).toHaveBeenCalledWith(FROM + 3_000_000);
  });

  it("maps the press through the track's real width, not a fixed one", async () => {
    // The bar is as wide as the wall leaves it. Reading the fraction off any
    // other width puts every seek off by the ratio between them.
    timeline.mockResolvedValue({ ranges: [range(0, 3_600)] });
    const pb = fakePlayback();
    const { container } = await show(pb);
    await screen.findByText("1 span in view");
    scrubTo(track(container, 400), 0.25, 400);
    expect(pb.playAt).toHaveBeenCalledWith(FROM + SPAN / 4);
  });

  it("clamps a press past the end of the track to the end of the window", async () => {
    timeline.mockResolvedValue({ ranges: [range(0, 3_600)] });
    const pb = fakePlayback();
    const { container } = await show(pb);
    await screen.findByText("1 span in view");
    const el = track(container);
    pointer(el, "pointerdown", 1_400);
    pointer(el, "pointerup", 1_400);
    expect(pb.playAt).toHaveBeenCalledWith(FROM + SPAN);
  });

  it("does not seek at all on a camera the recorder does not hold", async () => {
    // There is nothing to seek to, and a playAt here would move the whole wall
    // into playback over a camera with no timeline behind it.
    const pb = fakePlayback();
    const { container } = await show(pb, LOCAL_CAMERA);
    scrubTo(track(container), 0.5);
    expect(pb.playAt).not.toHaveBeenCalled();
  });
});
