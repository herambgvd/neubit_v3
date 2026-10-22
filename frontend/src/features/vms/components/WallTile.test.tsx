/**
 * PTZ FROM THE WALL (SCRUM-331).
 *
 * Every VMS drives PTZ from live view, so a wall tile showing a live camera with a
 * known head offers a PTZ key in its control bar. It is not offered where nothing
 * could answer: a dark camera, a recording, or an operator without vms.ptz.control
 * (Streaming passes `ptzAvailable` false for them).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EstateCamera } from "../types";
import WallTile from "./WallTile";

vi.mock("../api", () => ({ vms: { federation: { live: vi.fn() } } }));
const playback = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./TilePlayback", () => ({
  default: (p: Record<string, unknown>) => {
    playback.props = p;
    return null;
  },
}));
// The card's own behaviour is PtzOverlay's test; here, only where it is drawn.
vi.mock("./PtzOverlay", () => ({
  default: (p: Readonly<{ variant?: string; title?: string; onClose?: () => void }>) => (
    <button type="button" data-ptz-card="" data-testid="ptz-card" data-variant={p.variant} onClick={p.onClose}>
      {p.title}
    </button>
  ),
}));
// The player itself is out of scope: render only the controls the tile hands it.
vi.mock("./LivePlayer", () => ({
  default: ({ extraControls }: Readonly<{ extraControls?: React.ReactNode }>) => (
    <div data-testid="live-player">{extraControls}</div>
  ),
  PlayerBtn: ({ title, onClick, active }: Readonly<{ title: string; onClick?: () => void; active?: boolean }>) => (
    <button type="button" aria-label={title} aria-pressed={active} onClick={onClick} />
  ),
}));

const dome = (over: Partial<EstateCamera> = {}) =>
  ({
    id: "fed:rec-a:cam-1",
    real_id: "cam-1",
    node_id: "rec-a",
    federated: true,
    ptz_capable: true,
    name: "Gate dome",
    status: "online",
    ...over,
  }) as EstateCamera;

function tile(props: Partial<React.ComponentProps<typeof WallTile>> = {}) {
  const onTogglePtz = vi.fn();
  render(
    <WallTile
      index={2}
      cameraId="fed:rec-a:cam-1"
      camera={dome()}
      ptzAvailable
      onTogglePtz={onTogglePtz}
      {...props}
    />,
  );
  return { onTogglePtz };
}

const key = () => screen.queryByLabelText(/PTZ control/);

describe("the PTZ key on a wall tile", () => {
  it("opens PTZ for this tile's index", () => {
    const { onTogglePtz } = tile();
    fireEvent.click(screen.getByLabelText("PTZ control — move, zoom and presets"));
    expect(onTogglePtz).toHaveBeenCalledWith(2);
  });

  it("shows itself pressed, and offers to close, while PTZ is open here", () => {
    tile({ ptzOpen: true });
    expect(screen.getByLabelText("Close PTZ control").getAttribute("aria-pressed")).toBe("true");
  });

  it("is not offered when the wall says PTZ is not available", () => {
    tile({ ptzAvailable: false });
    expect(key()).toBeNull();
  });

  it("is not offered on a dark camera, which nothing would answer", () => {
    tile({ camera: dome({ status: "offline" }) });
    expect(key()).toBeNull();
  });

  it("is not offered over recorded footage, which cannot be steered", () => {
    tile({ playback: true });
    expect(key()).toBeNull();
  });
});

// SCRUM-334: a camera whose RECORDER is down keeps its tile, says so, and does not
// offer "Try anyway" — the recorder that would mint the stream is not answering.
describe("a tile whose recorder is down", () => {
  const down = () => dome({ status: "offline", status_reason: "recorder_offline" });

  it("says the recorder is offline, not the camera", () => {
    tile({ camera: down() });
    expect(screen.getByText("Recorder offline")).toBeTruthy();
    expect(screen.queryByText(/camera offline/i)).toBeNull();
  });

  it("offers no Try anyway, which could only wait out a dead recorder", () => {
    tile({ camera: down() });
    expect(screen.queryByText("Try anyway")).toBeNull();
  });

  it("still offers Try anyway for a camera that is itself offline", () => {
    tile({ camera: dome({ status: "offline" }) });
    expect(screen.getByText("Try anyway")).toBeTruthy();
    expect(screen.getByText(/camera offline/i)).toBeTruthy();
  });

  it("keeps its remove control, so the operator still owns the layout", () => {
    tile({ camera: down() });
    expect(screen.getByLabelText("Remove from wall")).toBeTruthy();
  });
});

describe("instant playback on a tile (SCRUM-337)", () => {
  const replay = () => screen.queryByLabelText(/Instant playback/);

  it("replays a recorder camera's last half-minute in its own tile", () => {
    const onInstantPlayback = vi.fn();
    tile({ onInstantPlayback });

    fireEvent.click(replay()!);

    expect(onInstantPlayback).toHaveBeenCalledWith(2);
  });

  it("is not offered on a camera no recorder holds, which has nothing to replay", () => {
    tile({ onInstantPlayback: vi.fn(), camera: dome({ federated: false }) });
    expect(replay()).toBeNull();
  });

  it("is not offered on a tile already playing back", () => {
    tile({ onInstantPlayback: vi.fn(), playback: true });
    expect(replay()).toBeNull();
  });
});

describe("a tile playing back (SCRUM-337)", () => {
  it("holds its picture in reverse — the wall steps it — and takes the frame steps", () => {
    tile({ playback: true, playbackPlaying: true, playbackSpeed: -2, playbackScrubMs: 1_000, playbackScrubSeq: 3, playbackRateMax: 8 });

    expect(playback.props).toMatchObject({ playing: false, speed: 0.25, scrubMs: 1_000, scrubSeq: 3, rateMax: 8 });
  });

  it("plays forward at the wall's speed", () => {
    tile({ playback: true, playbackPlaying: true, playbackSpeed: 2 });

    expect(playback.props).toMatchObject({ playing: true, speed: 2 });
  });
});

describe("a tile past Sync's limit (SCRUM-337)", () => {
  it("opens no stream, recorded or live, and says why", () => {
    playback.props = null;
    tile({ playbackCapped: true });

    expect(screen.getByText("Playback: 24 max")).toBeInTheDocument();
    expect(screen.getByText("Click to play this camera")).toBeInTheDocument();
    expect(playback.props).toBeNull();
    expect(screen.queryByTestId("live-player")).toBeNull();
  });

  it("offers neither PTZ nor instant playback, but keeps its own controls", () => {
    tile({ playbackCapped: true, onInstantPlayback: vi.fn() });

    expect(key()).toBeNull();
    expect(screen.queryByLabelText(/Instant playback/)).toBeNull();
    expect(screen.getByLabelText("Remove from wall")).toBeInTheDocument();
  });

  it("a click focuses it, and the focused tile always plays", () => {
    const onFocus = vi.fn();
    tile({ playbackCapped: true, onFocus });

    fireEvent.click(screen.getByText("Playback: 24 max"));

    expect(onFocus).toHaveBeenCalledWith(2);
  });
});

describe("the PTZ card on its own tile (SCRUM-338)", () => {
  it("opens on the camera it steers, as the recorder console's card", () => {
    tile({ ptzOpen: true });

    expect(screen.getByTestId("ptz-card").dataset.variant).toBe("tile");
    expect(screen.getByTestId("ptz-card")).toHaveTextContent("Gate dome");
  });

  it("closes for this tile from the card", () => {
    const { onTogglePtz } = tile({ ptzOpen: true });

    fireEvent.click(screen.getByTestId("ptz-card"));

    expect(onTogglePtz).toHaveBeenCalledWith(2);
  });

  it("holds the tile still while it is open: a press on the pad is steering", () => {
    tile({ ptzOpen: true });

    expect(screen.getByTestId("ptz-card").closest("[draggable]")?.getAttribute("draggable")).toBe("false");
  });

  it("is the box its menus keep inside", () => {
    tile({ ptzOpen: true });

    expect(screen.getByTestId("ptz-card").closest("[data-drop-bounds]")).not.toBeNull();
  });

  it("keeps its presses: no focus click, no spotlight, no keys taken by the tile", () => {
    const onFocus = vi.fn();
    const onSpotlight = vi.fn();
    tile({ ptzOpen: true, onFocus, onSpotlight });
    const card = screen.getByTestId("ptz-card");

    fireEvent.click(card);
    fireEvent.doubleClick(card);
    fireEvent.keyDown(card, { key: " " });

    expect(onFocus).not.toHaveBeenCalled();
    expect(onSpotlight).not.toHaveBeenCalled();
  });

  it("leaves the rest of the tile its own: a click there focuses it", () => {
    const onFocus = vi.fn();
    tile({ ptzOpen: true, onFocus });

    fireEvent.click(screen.getByText("Gate dome", { selector: "span" }));

    expect(onFocus).toHaveBeenCalledWith(2);
  });

  it("is not drawn where the wall says PTZ is not available", () => {
    tile({ ptzOpen: true, ptzAvailable: false });

    expect(screen.queryByTestId("ptz-card")).toBeNull();
  });
});
