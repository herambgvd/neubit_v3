/**
 * A wall cell holds a CAMERA ID and nothing else — a saved layout stores a camera,
 * and always will, because storing which recorder fronts it would mean re-saving
 * every layout in the estate whenever a camera moves.
 *
 * So the cell mints its live session with the id alone, through the default source.
 * That path used to 404 for every camera in a single-ownership estate (the recorders
 * own the cameras, so the VMS had no row to look up) and every cell on every wall was
 * dead. The backend resolves the owning recorder now; this pins the cell's half of
 * that contract — it must keep asking with the id alone.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { vms } from "@/features/vms/api";
import { renderWithProviders } from "@/test/render";

import WallCell from "./WallCell";

const CAM = "cam-on-a-recorder";

beforeEach(() => {
  vi.spyOn(vms.live, "start").mockResolvedValue({
    session_id: "s1",
    hls_url: "https://media/s1.m3u8",
    ready: true,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  } as never);
  vi.spyOn(vms.live, "renew").mockResolvedValue({ session_id: "s1" } as never);
  vi.spyOn(vms.live, "release").mockResolvedValue(undefined as never);
});

describe("a wall cell with a camera", () => {
  it("mints its live session with the camera id alone", async () => {
    renderWithProviders(<WallCell cameraId={CAM} camera={{ id: CAM, name: "Gate" } as never} />);

    await vi.waitFor(() => expect(vms.live.start).toHaveBeenCalled());
    // The id, and no recorder — the cell has none to give.
    expect(vms.live.start).toHaveBeenCalledWith(CAM, expect.any(String));
  });

  it("asks for nothing when the cell is empty", async () => {
    renderWithProviders(<WallCell cameraId={null} />);

    await screen.findByRole("button", { hidden: true }).catch(() => null);
    expect(vms.live.start).not.toHaveBeenCalled();
  });
});
