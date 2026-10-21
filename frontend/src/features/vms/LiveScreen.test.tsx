/**
 * A LIVE SCREEN'S OWN WINDOW (SCRUM-336) — /live-display/<key>.
 *
 * It is the live wall, keeping its grid under its screen's key, outside the app
 * chrome (and its alarm notifier: the main console rings once, not once per
 * monitor). It names its monitor, closes itself, and in a browser asks for the
 * one click full screen needs.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveScreenInfo } from "./Streaming";
import { rememberScreen, savedScreens } from "./liveScreens";

const auth = vi.hoisted(() => ({ status: "authed" as string }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: auth.status, can: () => true }) }));

const walls = vi.hoisted(() => ({ last: null as LiveScreenInfo | null }));
vi.mock("./Streaming", () => ({
  default: ({ screen: s }: { screen: LiveScreenInfo }) => {
    walls.last = s;
    return <div data-testid="wall">{s.label}</div>;
  },
}));

import LiveScreen from "./LiveScreen";

beforeEach(() => {
  auth.status = "authed";
  walls.last = null;
  localStorage.clear();
  window.history.replaceState(null, "", "/live-display/w1?name=DELL%20Right");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a live screen", () => {
  it("is the live wall, kept under its own key and named after its monitor", () => {
    render(<LiveScreen screenKey="w1" />);

    expect(screen.getByTestId("wall")).toHaveTextContent("DELL Right");
    expect(walls.last).toMatchObject({ key: "w1", label: "DELL Right" });
    expect(document.title).toBe("DELL Right · Live");
  });

  it("refuses a key that is not one, rather than keeping a wall under it", () => {
    render(<LiveScreen screenKey="../x" />);

    expect(screen.getByText("This is not a screen of this station.")).toBeInTheDocument();
    expect(screen.queryByTestId("wall")).toBeNull();
  });

  it("signed out, says where to sign in instead of showing a login form on a wall", () => {
    auth.status = "anon";
    render(<LiveScreen screenKey="w1" />);

    expect(screen.getByText(/Sign in on the main console/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("closing it closes the window and stops offering it back", () => {
    rememberScreen({ key: "w1", label: "DELL Right" });
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    render(<LiveScreen screenKey="w1" />);

    walls.last?.onClose();

    expect(close).toHaveBeenCalled();
    expect(savedScreens()).toEqual([]);
  });

  it("in a browser, asks for the one click full screen needs — and can be put away", async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    render(<LiveScreen screenKey="w1" />);

    await userEvent.click(screen.getByRole("button", { name: /Full screen on this monitor/ }));
    expect(requestFullscreen).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: /Full screen on this monitor/ })).toBeNull();
  });
});
