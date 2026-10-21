/**
 * "Screens" ON THE LIVE WALL — a live view on each monitor of the station
 * (SCRUM-336).
 *
 * The desktop app could put a monitor of a shared video wall on a screen, and
 * nothing else: the operator's own second monitor was a browser tab dragged over
 * by hand, and gone when the tab closed. Every VMS client offers this from the
 * live view itself — Milestone's secondary display, HikCentral's auxiliary screen.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NeubitBridge, ScreenLayout, ScreenSlot } from "@/lib/desktop";

import LiveScreensMenu from "./LiveScreensMenu";

function slot(over: Partial<ScreenSlot>): ScreenSlot {
  return {
    signature: "sig",
    label: "Screen",
    primary: false,
    attached: true,
    resolution: "1920 × 1080",
    open: false,
    console: false,
    assignment: null,
    ...over,
  };
}

const LAYOUT: ScreenLayout = {
  consoleUrl: "http://vms.local",
  screens: [
    slot({ signature: "sig-main", label: "Built-in", primary: true, console: true }),
    slot({ signature: "sig-right", label: "DELL Right" }),
    slot({
      signature: "sig-wall",
      label: "LG Wall",
      open: true,
      assignment: {
        kind: "wall",
        displaySignature: "sig-wall",
        displayLabel: "LG Wall",
        wallId: "w1",
        monitorId: "m2",
        wallLabel: "Control room",
        monitorLabel: "Monitor 2",
      },
    }),
    slot({
      signature: "sig-live",
      label: "Samsung Left",
      open: true,
      assignment: { kind: "live", displaySignature: "sig-live", displayLabel: "Samsung Left" },
    }),
    slot({
      signature: "sig-gone",
      label: "Old panel",
      attached: false,
      resolution: "",
      assignment: { kind: "live", displaySignature: "sig-gone", displayLabel: "Old panel" },
    }),
  ],
};

function bridge(): NeubitBridge {
  return {
    screensLayout: vi.fn(async () => LAYOUT),
    assignScreen: vi.fn(async () => LAYOUT),
    clearScreen: vi.fn(async () => LAYOUT),
    openLiveScreen: vi.fn(async () => LAYOUT),
    closeAllWalls: vi.fn(async () => LAYOUT),
    identifyScreens: vi.fn(async () => {}),
    onScreensChanged: vi.fn(() => () => {}),
  };
}

const rowOf = (label: string) => screen.getByText(label).closest("li") as HTMLElement;

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  delete window.neubit;
  delete (window as { getScreenDetails?: unknown }).getScreenDetails;
  vi.restoreAllMocks();
});

describe("in the desktop app", () => {
  async function openMenu(b: NeubitBridge) {
    window.neubit = b;
    render(<LiveScreensMenu />);
    await waitFor(() => expect(b.screensLayout).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole("button", { name: "Screens" }));
    await screen.findByText("DELL Right");
  }

  it("opens a live view on a screen the shell names, and on nothing it does not", async () => {
    const b = bridge();
    await openMenu(b);

    await userEvent.click(within(rowOf("DELL Right")).getByRole("button", { name: "Open live view" }));

    expect(b.openLiveScreen).toHaveBeenCalledWith("sig-right");
  });

  it("does not offer the console's own screen, which a full-screen window would cover", async () => {
    await openMenu(bridge());

    const row = rowOf("Built-in");
    expect(within(row).getByText("This console")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("says when a screen is a video wall monitor, and offers a live view instead", async () => {
    await openMenu(bridge());

    const row = rowOf("LG Wall");
    expect(within(row).getByText(/Video wall · Monitor 2/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Open live view" })).toBeInTheDocument();
  });

  it("closes a live view that is up, and counts it on the button", async () => {
    const b = bridge();
    await openMenu(b);

    const row = rowOf("Samsung Left");
    expect(within(row).getByText(/Live view open/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Close" }));

    expect(b.clearScreen).toHaveBeenCalledWith("sig-live");
    expect(screen.getByRole("button", { name: "Screens" })).toHaveTextContent("1");
  });

  it("keeps a live screen whose monitor is unplugged, and can forget it", async () => {
    const b = bridge();
    await openMenu(b);

    const row = rowOf("Old panel");
    expect(within(row).getByText(/Not plugged in/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Forget" }));

    expect(b.clearScreen).toHaveBeenCalledWith("sig-gone");
  });

  it("identifies the screens", async () => {
    const b = bridge();
    await openMenu(b);

    await userEvent.click(screen.getByRole("button", { name: /Identify/ }));

    expect(b.identifyScreens).toHaveBeenCalled();
  });
});

describe("in a browser that cannot place windows", () => {
  it("opens a live view in a new window, and offers it back afterwards", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<LiveScreensMenu />);
    await userEvent.click(screen.getByRole("button", { name: "Screens" }));

    expect(screen.getByText(/cannot place a window on a monitor/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open a live view in a new window" }));

    expect(open).toHaveBeenCalledWith("/live-display/w1?name=Window%201", "neubit-screen-w1", "popup,width=1280,height=800");
    expect(within(rowOf("Window 1")).getByRole("button", { name: "Open live view" })).toBeInTheDocument();
  });
});

describe("in a browser with the Window Management API", () => {
  const left = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040, width: 1920, height: 1080, left: 0, top: 0, isPrimary: true, label: "Built-in" };
  const right = { ...left, availLeft: 1920, left: 1920, availHeight: 1080, isPrimary: false, label: "DELL Right" };

  it("asks once to see the monitors, then opens the view placed on the one picked", async () => {
    const details = Object.assign(new EventTarget(), { screens: [left, right], currentScreen: left });
    const getScreenDetails = vi.fn(async () => details);
    (window as { getScreenDetails?: unknown }).getScreenDetails = getScreenDetails;
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    render(<LiveScreensMenu />);
    await userEvent.click(screen.getByRole("button", { name: "Screens" }));
    await userEvent.click(await screen.findByRole("button", { name: "Find my screens" }));

    expect(getScreenDetails).toHaveBeenCalledTimes(1);
    expect(within(rowOf("Built-in")).getByText("This console")).toBeInTheDocument();
    await userEvent.click(within(rowOf("DELL Right")).getByRole("button", { name: "Open live view" }));

    const [url, name, features] = open.mock.calls[0];
    expect(url).toMatch(/^\/live-display\/b[0-9a-f]{8}\?name=DELL%20Right$/);
    expect(name).toMatch(/^neubit-screen-b[0-9a-f]{8}$/);
    expect(features).toBe("popup,left=1920,top=0,width=1920,height=1080");
  });
});
