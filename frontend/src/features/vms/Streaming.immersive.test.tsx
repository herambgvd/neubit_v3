/**
 * THE LIVE WALL IN FULL SCREEN, AND ON ANOTHER MONITOR (SCRUM-335, SCRUM-336).
 *
 * Full screen used to take the wall element with its toolbar and rail, so the
 * monitor filled with the same chrome as before. Now the video has the screen and
 * the chrome floats over it, on the mouse.
 *
 * A live screen — the wall in another monitor's window — keeps its grid and its
 * preferences under its own key, durably: the desktop app reopens it at launch,
 * and closing the rail there must not close it on the main wall.
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "authed", can: () => true }) }));

import Streaming from "./Streaming";

let fullscreenElement: Element | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  document.documentElement.requestFullscreen = vi.fn(async () => {
    fullscreenElement = document.documentElement;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  stubApi({
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": { items: [], unreachable: [], nodes: 0 },
    "GET /vms/patterns": { items: [], total: 0 },
    "GET /vms/groups": { items: [], total: 0 },
    "GET /system/resources": { cpu_percent: 10, ram: { percent: 20 } },
  });
});

afterEach(cleanup);

/** The floating layer the chrome moves into while immersive. */
const floating = (el: HTMLElement) => el.closest(".z-40.absolute");

describe("full screen", () => {
  it("takes the document, and the toolbar leaves the wall's flow for the floating layer", async () => {
    renderWithProviders(<Streaming />);
    expect(floating(screen.getByTitle("Home"))).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Full screen/ }));

    expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
    expect(floating(screen.getByTitle("Home"))).not.toBeNull();
    expect(screen.getByRole("button", { name: "Exit full screen (Esc)" })).toBeInTheDocument();
  });

  it("the main wall offers its other monitors; it is not a screen itself", () => {
    renderWithProviders(<Streaming />);

    expect(screen.getByRole("button", { name: "Screens" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close this screen" })).toBeNull();
  });
});

describe("a live screen", () => {
  const onClose = vi.fn();
  const live = { key: "w1", label: "DELL Right", onClose };

  it("is immersive from the start, names its monitor, and offers no further screens", () => {
    renderWithProviders(<Streaming screen={live} />);

    expect(floating(screen.getByText("DELL Right"))).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Screens" })).toBeNull();
    expect(screen.queryByTitle("Home")).toBeNull();
  });

  it("keeps its wall under its own key, durably, and leaves the main wall's alone", () => {
    renderWithProviders(<Streaming screen={live} />);

    expect(localStorage.getItem("neubit.vms.screen.w1.layout")).not.toBeNull();
    expect(localStorage.getItem("neubit.vms.screen.w1.cells")).not.toBeNull();
    expect(sessionStorage.getItem("neubit.vms.wall.layout")).toBeNull();
    expect(sessionStorage.getItem("neubit.vms.wall.cells")).toBeNull();
  });

  it("comes back with the cameras it had", () => {
    localStorage.setItem("neubit.vms.screen.w1.layout", JSON.stringify("1x1"));
    localStorage.setItem("neubit.vms.screen.w1.cells", JSON.stringify([{ cameraId: "cam-9" }]));

    renderWithProviders(<Streaming screen={live} />);

    expect(JSON.parse(localStorage.getItem("neubit.vms.screen.w1.cells") || "[]")).toEqual([{ cameraId: "cam-9" }]);
  });

  it("collapsing its rail does not collapse the main wall's", async () => {
    localStorage.setItem("neubit.vms.wall.rail", "true");
    renderWithProviders(<Streaming screen={live} />);

    await userEvent.click(screen.getByRole("button", { name: /Collapse camera rail/ }));

    expect(localStorage.getItem("neubit.vms.wall.rail@w1")).toBe("false");
    expect(localStorage.getItem("neubit.vms.wall.rail")).toBe("true");
  });

  it("closes from its toolbar", async () => {
    renderWithProviders(<Streaming screen={live} />);

    await userEvent.click(screen.getByRole("button", { name: "Close this screen" }));

    expect(onClose).toHaveBeenCalled();
  });
});
