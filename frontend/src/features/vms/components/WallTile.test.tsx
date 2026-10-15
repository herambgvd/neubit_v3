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
vi.mock("./TilePlayback", () => ({ default: () => null }));
// The player itself is out of scope: render only the controls the tile hands it.
vi.mock("./LivePlayer", () => ({
  default: ({ extraControls }: Readonly<{ extraControls?: React.ReactNode }>) => <div>{extraControls}</div>,
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
