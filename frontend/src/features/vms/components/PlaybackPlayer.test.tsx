/**
 * The standalone player's TOOLBAR — what it offers on footage this platform does
 * not own.
 *
 * A federated tile's `cameraId` is the synthetic "<nodeId>:<realId>" the player
 * needs to address the recorder; bookmarks and evidence holds are keyed on this
 * platform's own camera rows (a uuid column). Writing one against a federated tile
 * is refused by the API with "Camera is too long" — verified against the running
 * service — and the LIST queries for both were already disabled for those tiles,
 * so a write that somehow landed could never be seen either.
 *
 * The buttons were offered anyway. They are not any more.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import PlaybackPlayer from "./PlaybackPlayer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
// hls.js / WASM decode are not the subject here.
vi.mock("./H265WebPlayer", () => ({ default: () => <div>h265</div> }));

const SESSION = {
  session_id: "s1",
  hls_url: "https://media/s1.m3u8?token=x",
  from: "2026-09-09T00:00:00Z",
  to: "2026-09-09T23:59:59Z",
  ranges: [],
  expires_at: new Date(Date.now() + 300_000).toISOString(),
};

function stubAll() {
  return stubApi({
    "GET /vms/cameras/*": { id: "cam-1", name: "Lobby" },
    "POST /vms/cameras/*": SESSION,
    "GET /vms/bookmarks": { items: [], total: 0 },
    "GET /vms/evidence": { items: [], total: 0 },
    "GET /vms/events": { items: [], total: 0 },
  });
}

describe("a synced grid tile with nothing to play", () => {
  /**
   * The recorder answers 200 with an empty playback_url for a window holding no
   * footage. The tile rendered `loading || (!hlsUrl && !error)` as a spinner, so
   * that normal answer became a cell that span forever — indistinguishable from a
   * recorder taking its time, and on an estate where nothing was recording it was
   * every cell on the page.
   */
  it("says there is no footage instead of spinning forever", async () => {
    stubAll();
    const empty = { ...SESSION, hls_url: "", webrtc_url: "", ranges: [] };
    renderWithProviders(
      <PlaybackPlayer
        cameraId="n1:fed-cam-1"
        cameraName="Channel 1"
        controlled
        windowStart={Date.parse("2026-09-09T00:00:00Z")}
        windowEnd={Date.parse("2026-09-09T23:59:59Z")}
        sourceFn={async () => empty as never}
      />,
    );

    expect(await screen.findByText(/no footage in this window/i)).toBeInTheDocument();
  });

  it("still spins while the recorder has not answered yet", async () => {
    stubAll();
    const { container } = renderWithProviders(
      <PlaybackPlayer
        cameraId="n1:fed-cam-1"
        cameraName="Channel 1"
        controlled
        windowStart={Date.parse("2026-09-09T00:00:00Z")}
        windowEnd={Date.parse("2026-09-09T23:59:59Z")}
        sourceFn={() => new Promise(() => {})}
      />,
    );

    expect(container.querySelector(".iconify")).toBeTruthy();
    expect(screen.queryByText(/no footage in this window/i)).toBeNull();
  });
});

describe("footage this platform owns", () => {
  it("offers bookmarking and an evidence hold", async () => {
    stubAll();
    renderWithProviders(<PlaybackPlayer cameraId="cam-1" cameraName="Lobby" />);

    expect(await screen.findByTitle("Bookmark this moment")).toBeInTheDocument();
    expect(screen.getByTitle("Lock this window as evidence")).toBeInTheDocument();
  });
});

describe("footage a recorder owns", () => {
  it("offers neither — both would be refused, and neither could be listed back", async () => {
    stubAll();
    renderWithProviders(
      <PlaybackPlayer
        cameraId="n1:fed-cam-1"
        cameraName="Channel 1"
        nodeId="n1"
        realCameraId="fed-cam-1"
        sourceFn={async () => SESSION as never}
      />,
    );

    // The player itself is there…
    expect(await screen.findByTitle("Snapshot")).toBeInTheDocument();
    // …without the two controls that cannot work on it.
    expect(screen.queryByTitle("Bookmark this moment")).toBeNull();
    expect(screen.queryByTitle("Lock this window as evidence")).toBeNull();
  });

  it("still offers motion search, which the recorder DOES answer", async () => {
    stubAll();
    renderWithProviders(
      <PlaybackPlayer
        cameraId="n1:fed-cam-1"
        cameraName="Channel 1"
        nodeId="n1"
        realCameraId="fed-cam-1"
        sourceFn={async () => SESSION as never}
      />,
    );

    expect(await screen.findByTitle("Smart motion search")).toBeInTheDocument();
  });
});
