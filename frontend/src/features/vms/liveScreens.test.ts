/**
 * LIVE SCREENS — a live view of its own on each monitor of a station (SCRUM-336).
 *
 * The pieces a browser needs, the desktop app having its own: where a screen's
 * page lives, a key per monitor that its wall is kept under, the screens this
 * browser opened (it cannot reopen anything by itself, so it offers them back),
 * the Window Management API's monitor list, and which screens are up right now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

import {
  announceScreen,
  browserScreens,
  forgetScreen,
  isScreenKey,
  liveDisplayPath,
  openScreenWindow,
  rememberScreen,
  savedScreens,
  screenKey,
  watchScreens,
  type ScreenDetails,
} from "./liveScreens";

beforeEach(() => localStorage.clear());

describe("a screen's page", () => {
  it("is /live-display/<key>, with the monitor's name as text, encoded", () => {
    expect(liveDisplayPath("b1a2b3c4", "DELL U2419H <2>")).toBe(
      "/live-display/b1a2b3c4?name=DELL%20U2419H%20%3C2%3E",
    );
  });

  it("only takes a key that is safe in a path and a storage key", () => {
    expect(isScreenKey("d0a1b2c3")).toBe(true);
    expect(isScreenKey("w2")).toBe(true);
    expect(isScreenKey("../x")).toBe(false);
    expect(isScreenKey("a/b")).toBe(false);
    expect(isScreenKey("")).toBe(false);
  });

  it("keys a monitor the same way every time, apart from every other", () => {
    expect(screenKey("b", "DELL|1920,0|1920x1080")).toBe(screenKey("b", "DELL|1920,0|1920x1080"));
    expect(screenKey("b", "DELL|1920,0|1920x1080")).not.toBe(screenKey("b", "DELL|0,0|1920x1080"));
    expect(screenKey("b", "x")).toMatch(/^b[0-9a-f]{8}$/);
  });
});

describe("the screens this browser opened", () => {
  it("are remembered, replaced by key, and forgotten", () => {
    rememberScreen({ key: "w1", label: "Window 1" });
    rememberScreen({ key: "w2", label: "Window 2" });
    rememberScreen({ key: "w1", label: "Window 1 again" });

    expect(savedScreens().map((s) => s.label)).toEqual(["Window 2", "Window 1 again"]);

    forgetScreen("w2");
    expect(savedScreens().map((s) => s.key)).toEqual(["w1"]);
  });

  it("ignore anything in storage that is not one", () => {
    localStorage.setItem(
      "neubit.vms.screens",
      JSON.stringify([{ key: "../evil", label: "x" }, { key: "w1" }, null, { key: "w3", label: "Window 3" }]),
    );
    expect(savedScreens().map((s) => s.key)).toEqual(["w3"]);

    localStorage.setItem("neubit.vms.screens", "{not json");
    expect(savedScreens()).toEqual([]);
  });
});

describe("the monitors, from the Window Management API", () => {
  const left = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040, width: 1920, height: 1080, left: 0, top: 0, isPrimary: true, label: "Built-in" };
  const right = { ...left, availLeft: 1920, left: 1920, availHeight: 1080, isPrimary: false, label: "" };
  const details = { screens: [left, right], currentScreen: left } as unknown as ScreenDetails;

  it("names each, marks the one this window is on, and places on its free area", () => {
    const [a, b] = browserScreens(details);

    expect(a).toMatchObject({ label: "Built-in", primary: true, current: true, resolution: "1920 × 1080" });
    expect(b).toMatchObject({ label: "Screen 2", primary: false, current: false, left: 1920, top: 0, width: 1920 });
    expect(a.key).not.toBe(b.key);
  });
});

describe("opening a screen's window", () => {
  afterEach(() => vi.restoreAllMocks());

  it("places it on its monitor and names it, so a second click finds the same window", () => {
    const focus = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({ focus } as unknown as Window);

    openScreenWindow({ key: "b00ff00ff", label: "Right", left: 1920, top: 0, width: 1920, height: 1080 });

    expect(open).toHaveBeenCalledWith(
      "/live-display/b00ff00ff?name=Right",
      "neubit-screen-b00ff00ff",
      "popup,left=1920,top=0,width=1920,height=1080",
    );
    expect(focus).toHaveBeenCalled();
  });

  it("without a monitor to place it on, opens a window to be moved", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    openScreenWindow({ key: "w1", label: "Window 1" });

    expect(open.mock.calls[0][2]).toBe("popup,width=1280,height=800");
  });
});

describe("which screens are up", () => {
  it("the console hears a screen arrive and leave, and can ask it to close", async () => {
    const seen: string[][] = [];
    const watch = watchScreens((open) => seen.push([...open]));
    const closeRequested = vi.fn();

    const stop = announceScreen("w1", closeRequested);
    await waitFor(() => expect(seen.at(-1)).toEqual(["w1"]));

    watch.close("w1");
    await waitFor(() => expect(closeRequested).toHaveBeenCalledTimes(1));

    stop();
    await waitFor(() => expect(seen.at(-1)).toEqual([]));
    watch.stop();
  });

  it("a console that reloads asks, and the screens already up answer", async () => {
    const stop = announceScreen("w2", () => undefined);
    const seen: string[][] = [];

    const watch = watchScreens((open) => seen.push([...open]));

    await waitFor(() => expect(seen.at(-1)).toEqual(["w2"]));
    stop();
    watch.stop();
  });
});
