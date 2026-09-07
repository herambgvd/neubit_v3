/**
 * An alarm popup holds a CAMERA ID and nothing else — an incident carries a camera,
 * not a recorder, and it never will: the event that raised it came from a device, and
 * which box fronts that device is a placement decision the popup has no business
 * storing.
 *
 * So the popup mints its live session with the id alone, through the default source.
 * That path used to 404 for every camera in a single-ownership estate (the recorders
 * own the cameras, so the VMS had no row to look up) and every alarm popup came up
 * with a dead player. The backend resolves the owning recorder now; this pins the
 * popup's half — it must keep asking with the id alone.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { vms } from "../api";
import * as popups from "../hooks/useVmsPopups";
import VmsPopupHost from "./VmsPopupHost";

const CAM = "cam-on-a-recorder";

function popup(over: Record<string, unknown> = {}) {
  return {
    key: "p1",
    camera_id: CAM,
    reason: "door forced at Lobby",
    event_type: "motion",
    severity: "alarm",
    occurred_at: new Date().toISOString(),
    ...over,
  };
}

function stubPopups(active: ReturnType<typeof popup>[]) {
  return vi.spyOn(popups, "useVmsPopups").mockReturnValue({
    active,
    dismiss: vi.fn(),
    acknowledge: vi.fn(),
  } as never);
}

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

describe("an alarm popup", () => {
  it("mints its live session with the camera id alone", async () => {
    stubPopups([popup()]);

    renderWithProviders(<VmsPopupHost />);

    await vi.waitFor(() => expect(vms.live.start).toHaveBeenCalled());
    expect(vms.live.start).toHaveBeenCalledWith(CAM, expect.any(String));
    // And it still shows WHY it popped — a live tile with no reason is just a tile.
    expect(screen.getByText(/door forced at Lobby/i)).toBeInTheDocument();
  });

  it("renders nothing at all when there is no popup", () => {
    stubPopups([]);

    const { container } = renderWithProviders(<VmsPopupHost />);

    expect(container).toBeEmptyDOMElement();
    expect(vms.live.start).not.toHaveBeenCalled();
  });

  it("skips a popup that names no camera instead of asking for one", async () => {
    // The toast alone covers a camera-less popup. Asking the live plane for a
    // session with an empty id would 404 every time one arrived.
    stubPopups([popup({ camera_id: null })]);

    renderWithProviders(<VmsPopupHost />);

    expect(vms.live.start).not.toHaveBeenCalled();
  });
});
