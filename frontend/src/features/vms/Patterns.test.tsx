/**
 * VMS → Patterns and Groups. Two lists behind one segment, and the pair is the
 * only way a wall gets a saved arrangement:
 *
 *   a GROUP is cameras placed into a grid layout;
 *   a PATTERN is groups rotated on a dwell.
 *
 * So what is worth testing is that the round trip actually works — that the
 * builder's placements reach the API as `camera_ids` in cell order, that the two
 * tabs write to their OWN endpoints (they share every control on the screen), and
 * that a delete asks first. A wrong body here is a wall that comes up with the
 * wrong cameras in the wrong cells, which nobody can debug from the wall.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import PatternsPage from "./Patterns";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

/** The tab the page reads from ?view=. */
const view = { current: null as string | null };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(view.current ? `view=${view.current}` : ""),
}));

const GROUPS = {
  items: [
    {
      id: "g1",
      name: "lobby-wall",
      description: "front of house",
      camera_ids: ["cam-1", "cam-2"],
      layout: "2x2",
      is_active: true,
    },
    { id: "g2", name: "yard", camera_ids: ["cam-3"], layout: "1x1", is_active: false },
  ],
  total: 2,
};

const PATTERNS = {
  items: [
    {
      id: "p1",
      name: "night-sweep",
      description: "after hours",
      camera_group_ids: ["g1", "g2"],
      seconds: 20,
      is_active: true,
    },
  ],
  total: 1,
};

const CAMERAS = {
  items: [
    { id: "cam-1", name: "Lobby north", status: "online" },
    { id: "cam-2", name: "Lobby south", status: "online" },
    { id: "cam-3", name: "Yard gate", status: "offline" },
  ],
  total: 3,
};

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /vms/patterns": PATTERNS,
    "GET /vms/camera-groups": GROUPS,
    "GET /vms/cameras": CAMERAS,
    "GET /vms/federation/cameras": { items: [], unreachable: [] },
    "POST /vms/camera-groups": { id: "new-g", name: "made-up" },
    "POST /vms/patterns": { id: "new-p", name: "made-up" },
    "PATCH /vms/camera-groups/*": { id: "g1" },
    "PATCH /vms/patterns/*": { id: "p1" },
    "DELETE /vms/camera-groups/*": {},
    "DELETE /vms/patterns/*": {},
    ...over,
  });
  return stub;
}

beforeEach(() => {
  view.current = null;
  stubAll();
});

describe("patterns", () => {
  it("lists them with their rotation, and opens the first without being asked", async () => {
    renderWithProviders(<PatternsPage />);

    expect(await screen.findAllByText("night-sweep")).not.toHaveLength(0);
    // The detail resolves each rotation step to the GROUP's name — a stored id
    // tells an operator nothing.
    expect(await screen.findByText("lobby-wall")).toBeInTheDocument();
    expect(screen.getByText(/20s rotation/i)).toBeInTheDocument();
  });

  it("reports a failed load instead of an empty library", async () => {
    stubAll({ "GET /vms/patterns": () => httpError(503, "patterns are unavailable") });
    renderWithProviders(<PatternsPage />);

    expect(await screen.findByText(/patterns are unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no patterns yet/i)).toBeNull();
  });

  it("creates one through the pattern endpoint, with its dwell and groups", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("night-sweep");

    await userEvent.click(screen.getByRole("button", { name: /new pattern/i }));
    await userEvent.type(await screen.findByLabelText(/^name/i), "morning");
    const seconds = screen.getByLabelText(/seconds|dwell/i);
    await userEvent.clear(seconds);
    await userEvent.type(seconds, "45");
    await userEvent.click(screen.getByRole("button", { name: /lobby-wall/i }));
    await userEvent.click(screen.getByRole("button", { name: /create pattern|save/i }));

    await waitFor(() => expect(stub.matching("POST /vms/patterns")).toHaveLength(1));
    const body = stub.body("POST /vms/patterns")!;
    expect(body.name).toBe("morning");
    expect(body.seconds).toBe(45);
    expect(body.camera_group_ids).toEqual(["g1"]);
    // A pattern must never be written to the groups endpoint — they share every
    // control on this screen and differ only by the tab.
    expect(stub.matching("POST /vms/camera-groups")).toHaveLength(0);
  });

  it("asks before deleting, then deletes the named one", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("night-sweep");

    await userEvent.click(screen.getAllByRole("button", { name: /^delete$/i })[0]);
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /vms/patterns/p1")).toHaveLength(0);

    await userEvent.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);
    await waitFor(() => expect(stub.matching("DELETE /vms/patterns/p1")).toHaveLength(1));
  });
});

describe("groups", () => {
  beforeEach(() => {
    view.current = "groups";
  });

  it("is called Groups, not Camera Groups", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("lobby-wall");

    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.queryByText(/camera groups/i)).toBeNull();
  });

  it("shows each cell's camera by NAME, and says when one is gone", async () => {
    // A cell holds an id. Printing `fed:<node>:<cam>` at an operator is not a
    // thing they can act on, and an empty cell is not the same as a missing one.
    stubAll({
      "GET /vms/camera-groups": {
        items: [{ id: "g1", name: "lobby-wall", camera_ids: ["cam-1", "gone"], layout: "2x2", is_active: true }],
      },
    });
    renderWithProviders(<PatternsPage />);

    expect(await screen.findByText("Lobby north")).toBeInTheDocument();
    expect(screen.getByText(/camera unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("saves the builder's placements as camera_ids, in cell order", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("lobby-wall");

    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(await screen.findByLabelText(/^name/i), "gatehouse");

    // Place two cameras: the builder assigns to the first free cell.
    await userEvent.click(screen.getByRole("button", { name: /Yard gate/i }));
    await userEvent.click(screen.getByRole("button", { name: /Lobby south/i }));
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));

    await waitFor(() => expect(stub.matching("POST /vms/camera-groups")).toHaveLength(1));
    const body = stub.body("POST /vms/camera-groups")!;
    expect(body.name).toBe("gatehouse");
    // Cell ORDER is the wall's layout — a set would put the cameras in the wrong
    // places and look like a rendering bug.
    expect(body.camera_ids).toEqual(["cam-3", "cam-2"]);
    expect(body.layout).toBeTruthy();
  });

  it("refuses to save a group with no camera in it", async () => {
    // An empty group applied to the wall clears it — the wall goes black and the
    // group looks broken rather than empty.
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("lobby-wall");

    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(await screen.findByLabelText(/^name/i), "empty-one");
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));

    expect(await screen.findByText(/place at least one camera/i)).toBeInTheDocument();
    expect(stub.matching("POST /vms/camera-groups")).toHaveLength(0);
  });

  it("toggles active through the groups endpoint", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("lobby-wall");

    // The row action and the detail's button are the same action; either proves
    // the endpoint. Use the detail's, which names the open group.
    const detail = screen.getByRole("heading", { name: "lobby-wall" }).closest("section")!;
    await userEvent.click(within(detail).getByRole("button", { name: /deactivate/i }));

    await waitFor(() => expect(stub.matching("PATCH /vms/camera-groups/g1")).toHaveLength(1));
    expect(stub.body("PATCH /vms/camera-groups/g1")).toEqual({ is_active: false });
    expect(stub.matching("PATCH /vms/patterns/*")).toHaveLength(0);
  });

  it("counts active and inactive separately", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("lobby-wall");

    expect(screen.getByTitle("active")).toHaveTextContent("1");
    expect(screen.getByTitle("inactive")).toHaveTextContent("1");
  });

  it("filters the list by name", async () => {
    renderWithProviders(<PatternsPage />);
    await screen.findAllByText("lobby-wall");

    await userEvent.type(screen.getByPlaceholderText(/search groups/i), "yard");

    // The detail keeps showing whatever is open; the LIST is what filters.
    await waitFor(() => expect(screen.getAllByText("yard").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("lobby-wall")).toHaveLength(0);
  });
});
