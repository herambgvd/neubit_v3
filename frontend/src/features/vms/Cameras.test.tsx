/**
 * VMS → Cameras. Single ownership means this page is a read-through of what the
 * recorder nodes report, so the properties that matter are about what the list
 * CLAIMS: a federation call that failed must not read as "no cameras — register
 * a recorder", the composite `fed:<node>:<camera>` id must be the one handed to
 * the detail pane (it is the id the wall and the floor plan key on too), and the
 * first camera must be shown without the operator clicking.
 *
 * The detail pane is stubbed: it mints a live session, and this test is about
 * the list, not the player.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { sites as sitesApi } from "@/lib/api/sites";

import CamerasPage from "./Cameras";
import { vms } from "./api";

/** The address bar the page reads its drill-down filters from. */
const nav = { params: new URLSearchParams() };
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock("./components/FederatedCameraDetail", () => ({
  default: ({ camera }: { camera: { id: string; name: string } }) => (
    <div>
      <h1>{camera.name}</h1>
      <p data-testid="camera-id">{camera.id}</p>
    </div>
  ),
}));

const camera = (id: string, name: string, nodeId: string, status = "online") => ({
  id,
  name,
  status,
  node_id: nodeId,
  node_name: `${nodeId}-recorder`,
  ptz: { capable: false },
});

const camsReturn = (items: ReturnType<typeof camera>[]) =>
  vi.spyOn(vms.federation, "cameras").mockResolvedValue({ items, unreachable: [] } as never);

beforeEach(() => {
  nav.params = new URLSearchParams();
  vi.spyOn(vms.federation, "nodes").mockResolvedValue({ items: [], total: 0 } as never);
});

describe("a failed load", () => {
  it("reports the failure instead of an estate with no cameras", async () => {
    vi.spyOn(vms.federation, "cameras").mockRejectedValue(new Error("nodes did not answer"));

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByText(/nodes did not answer/i)).toBeInTheDocument();
    expect(screen.queryByText(/register a recorder to surface/i)).not.toBeInTheDocument();
  });

  it("invites recorder registration only when the call actually succeeded", async () => {
    camsReturn([]);

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByText(/register a recorder to surface/i)).toBeInTheDocument();
  });

  it("distinguishes 'nothing matches your search' from 'nothing exists'", async () => {
    camsReturn([camera("c1", "Lobby", "n1")]);

    renderWithProviders(<CamerasPage />);
    await screen.findByRole("heading", { name: "Lobby" });

    await userEvent.type(screen.getByPlaceholderText(/search name or recorder/i), "zzz");

    expect(await screen.findByText(/no cameras match/i)).toBeInTheDocument();
    expect(screen.queryByText(/register a recorder to surface/i)).not.toBeInTheDocument();
  });
});

describe("what the detail pane is given", () => {
  it("shows the first camera without the operator choosing anything", async () => {
    camsReturn([camera("c1", "Lobby", "n1"), camera("c2", "Dock", "n2")]);

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByRole("heading", { name: "Lobby" })).toBeInTheDocument();
    expect(screen.queryByText(/no camera selected/i)).not.toBeInTheDocument();
  });

  it("keys the camera by its node-qualified id, the one the wall and floor plan share", async () => {
    camsReturn([camera("c1", "Lobby", "n1")]);

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByTestId("camera-id")).toHaveTextContent("fed:n1:c1");
  });

  it("switches the detail pane to the camera the operator picks", async () => {
    camsReturn([camera("c1", "Lobby", "n1"), camera("c2", "Dock", "n2")]);

    renderWithProviders(<CamerasPage />);
    await userEvent.click(await screen.findByRole("button", { name: /dock/i }));

    expect(await screen.findByRole("heading", { name: "Dock" })).toBeInTheDocument();
    expect(await screen.findByTestId("camera-id")).toHaveTextContent("fed:n2:c2");
  });

  it("re-selects a camera that is still present after the status filter changes", async () => {
    camsReturn([camera("c1", "Lobby", "n1", "offline"), camera("c2", "Dock", "n2", "online")]);

    renderWithProviders(<CamerasPage />);
    await screen.findByRole("heading", { name: "Lobby" });

    await userEvent.click(screen.getByRole("button", { name: /all statuses/i }));
    // Exact: "Not online" is an option too, since the estate map links to it.
    await userEvent.click(await screen.findByRole("option", { name: /^online$/i }));

    expect(await screen.findByRole("heading", { name: "Dock" })).toBeInTheDocument();
  });

  it("counts online and offline cameras of the visible set", async () => {
    camsReturn([
      camera("c1", "Lobby", "n1", "online"),
      camera("c2", "Dock", "n2", "offline"),
      camera("c3", "Gate", "n2", "offline"),
    ]);

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByText("1 online")).toBeInTheDocument();
    expect(screen.getByText("2 offline")).toBeInTheDocument();
  });
});

describe("opened from the estate map (SCRUM-311)", () => {
  const placedAt = () =>
    vi.spyOn(sitesApi.devicePlacements, "index").mockResolvedValue({
      items: [
        // Placed under the wall's composite id, as the floor plan does.
        { device_id: "fed:n1:c1", device_type: "camera", site_id: "s1", floor_id: "f1", site_name: "Gvd gurugram" },
        { device_id: "fed:n1:c3", device_type: "camera", site_id: "s1", floor_id: "f1", site_name: "Gvd gurugram" },
        { device_id: "fed:n2:c2", device_type: "camera", site_id: "s2", floor_id: "f2", site_name: "Gvd Delhi" },
      ],
      count: 3,
    } as never);

  it("lists only the cameras placed at the site, and says which site", async () => {
    nav.params = new URLSearchParams("site=s1");
    placedAt();
    camsReturn([camera("c1", "Lobby", "n1"), camera("c2", "Dock", "n2"), camera("c3", "Gate", "n1", "error")]);

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByText("Site: Gvd gurugram")).toBeInTheDocument();
    expect(await screen.findByText("Gate")).toBeInTheDocument();
    expect(screen.queryByText("Dock")).not.toBeInTheDocument();
  });

  it("narrows to the ones the map counted as offline — anything but online", async () => {
    nav.params = new URLSearchParams("site=s1&status=not_online");
    placedAt();
    camsReturn([camera("c1", "Lobby", "n1"), camera("c2", "Dock", "n2", "offline"), camera("c3", "Gate", "n1", "error")]);

    renderWithProviders(<CamerasPage />);

    expect(await screen.findByRole("heading", { name: "Gate" })).toBeInTheDocument();
    expect(screen.queryByText("Lobby")).not.toBeInTheDocument();
    // Offline, but at another site.
    expect(screen.queryByText("Dock")).not.toBeInTheDocument();
  });

  it("shows every site again when the site chip is cleared", async () => {
    nav.params = new URLSearchParams("site=s1");
    placedAt();
    camsReturn([camera("c1", "Lobby", "n1"), camera("c2", "Dock", "n2")]);

    renderWithProviders(<CamerasPage />);
    await screen.findByText("Site: Gvd gurugram");

    await userEvent.click(screen.getByRole("button", { name: /show cameras at every site/i }));
    expect(await screen.findByText("Dock")).toBeInTheDocument();
    expect(screen.queryByText(/^Site:/)).not.toBeInTheDocument();
  });
});
