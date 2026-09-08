/**
 * The wall toolbar.
 *
 * This row sits above a live wall, so every character in it is width a tile does
 * not get. The rule is icons with titles: the hover and the screen reader still
 * get the wording, the pixels go to video. Playback, the view modes, Tour and
 * Save-group each carried a word beside their icon.
 *
 * Two things that must NOT be lost with the labels:
 *   • a toggle has to say it is on — the lit state and `aria-pressed` are the
 *     only signal left once the word is gone;
 *   • every control keeps an accessible name, or an icon row is unusable by
 *     anything that is not a pair of eyes.
 *
 * The host-load chip is here for the same reason the row is tight: when a nine-up
 * wall starts dropping frames the first question is whether the box has headroom.
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import WallToolbar, { type WallToolbarProps } from "./WallToolbar";

function props(over: Partial<WallToolbarProps> = {}): WallToolbarProps {
  return {
    railOpen: true,
    onToggleRail: vi.fn(),
    layoutKey: "2x2",
    onLayoutChange: vi.fn(),
    liveCount: 2,
    onlineCount: 4,
    viewMode: "grid",
    onViewMode: vi.fn(),
    quality: "auto",
    onQuality: vi.fn(),
    playoutOpen: false,
    onTogglePlayout: vi.fn(),
    alarmCount: 0,
    onSaveGroup: vi.fn(),
    canSaveGroup: true,
    allMuted: false,
    onToggleMuteAll: vi.fn(),
    onFullscreen: vi.fn(),
    onClear: vi.fn(),
    onRefresh: vi.fn(),
    ...over,
  };
}

const RESOURCES = { cpu_percent: 41.4, cpu_cores: 8, ram: { percent: 62.7 } };

beforeEach(() => {
  stubApi({ "GET /system/resources": RESOURCES });
});

afterEach(cleanup);

describe("the control row", () => {
  it("labels every control without printing a word beside it", async () => {
    renderWithProviders(<WallToolbar {...props()} />);

    for (const name of [
      /playback/i,
      /grid — camera tiles/i,
      /map — cameras on the floor plan/i,
      /start a tour/i,
      /save the current wall as a reusable group/i,
    ]) {
      const button = screen.getByRole("button", { name });
      // The name comes from the title/aria-label, so the icon carries no text.
      expect(button.textContent?.trim()).toBe("");
    }
  });

  it("says which view mode is on, now that the word is gone", async () => {
    renderWithProviders(<WallToolbar {...props({ viewMode: "map" })} />);

    expect(screen.getByRole("button", { name: /map — cameras/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /grid — camera tiles/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("switches the view mode when one is clicked", async () => {
    const p = props();
    renderWithProviders(<WallToolbar {...p} />);

    await userEvent.click(screen.getByRole("button", { name: /split/i }));
    expect(p.onViewMode).toHaveBeenCalledWith("split");
  });
});

describe("playback", () => {
  it("toggles the transport", async () => {
    const p = props();
    renderWithProviders(<WallToolbar {...p} />);

    await userEvent.click(screen.getByRole("button", { name: /playback/i }));
    expect(p.onTogglePlayout).toHaveBeenCalled();
  });

  it("names the way out while it is open", async () => {
    // With no label beside the icon, the title is what tells an operator the
    // control they are about to press closes the dock rather than opening it.
    renderWithProviders(<WallToolbar {...props({ playoutOpen: true })} />);

    expect(screen.getByRole("button", { name: /close playback/i })).toBeInTheDocument();
  });
});

describe("the tour control", () => {
  it("offers stop while a tour is running, and keeps the dwell visible", async () => {
    const onStopTour = vi.fn();
    const p = props({
      tour: { active: true, pages: [["a"], ["b"]], index: 0, seconds: 15 },
      onStopTour,
    });
    renderWithProviders(<WallToolbar {...p} />);

    await userEvent.click(screen.getByRole("button", { name: /stop the tour/i }));
    expect(onStopTour).toHaveBeenCalled();
    // The seconds are a VALUE, not a label — they stay printed.
    expect(screen.getByText("15s")).toBeInTheDocument();
  });
});

describe("host load", () => {
  it("shows the CPU and RAM of the box decoding these tiles", async () => {
    renderWithProviders(<WallToolbar {...props()} />);

    const chip = await screen.findByTitle(/host load/i);
    expect(chip.textContent).toContain("41%");
    expect(chip.textContent).toContain("63%");
  });

  it("shows nothing at all when the reading cannot be had", async () => {
    // An operator without system.read, or a host that will not answer, must not
    // get a permanent "0% · 0%" — that is a claim about the machine.
    stubApi({ "GET /system/resources": () => httpError(403, "forbidden") });
    renderWithProviders(<WallToolbar {...props()} />);

    await screen.findByRole("button", { name: /playback/i });
    expect(screen.queryByTitle(/host load/i)).toBeNull();
    expect(screen.queryByText(/0%/)).toBeNull();
  });
});
