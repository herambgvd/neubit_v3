/**
 * The desktop-shell bridge. ONE console serves both a browser tab and the
 * Electron shell, so every capability here has to be additive: in a browser the
 * bridge is simply absent and the UI that depends on it is not rendered.
 *
 * `useIsDesktop` is a hook rather than a bare boolean read for one reason, and
 * these tests are that reason: it must report FALSE during the render Next does
 * on the server (and during hydration), or React reports a mismatch between the
 * markup with the desktop controls and the markup without them.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { desktopBridge, useIsDesktop, useScreens, type NeubitBridge, type ScreenLayout } from "./desktop";

const LAYOUT: ScreenLayout = {
  consoleUrl: "http://console.local",
  screens: [
    {
      signature: "sig-1",
      label: "DELL U2720Q",
      primary: true,
      attached: true,
      resolution: "3840x2160",
      open: false,
      assignment: null,
    },
  ],
};

/** A stand-in for what desktop/src/preload exposes on `window.neubit`. */
function fakeBridge(overrides: Partial<NeubitBridge> = {}): NeubitBridge {
  return {
    screensLayout: vi.fn(async () => LAYOUT),
    assignScreen: vi.fn(async () => LAYOUT),
    clearScreen: vi.fn(async () => LAYOUT),
    closeAllWalls: vi.fn(async () => LAYOUT),
    identifyScreens: vi.fn(async () => {}),
    onScreensChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

function installBridge(bridge: NeubitBridge) {
  window.neubit = bridge;
}

afterEach(() => {
  delete window.neubit;
});

function Probe() {
  const isDesktop = useIsDesktop();
  return <span data-testid="desktop">{String(isDesktop)}</span>;
}

describe("desktopBridge", () => {
  it("is null in a browser, where the shell has exposed nothing", () => {
    expect(desktopBridge()).toBeNull();
  });

  it("is the shell's own bridge when the console runs inside the desktop app", () => {
    const bridge = fakeBridge();
    installBridge(bridge);

    expect(desktopBridge()).toBe(bridge);
  });
});

describe("useIsDesktop", () => {
  it("is false on the server render even when a bridge would exist — the hydration mismatch this avoids", () => {
    installBridge(fakeBridge());

    // renderToString runs the same code path Next's prerender does: no effects.
    expect(renderToString(<Probe />)).toContain(">false<");
  });

  it("is false in a browser, and stays false", async () => {
    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId("desktop")).toHaveTextContent("false"));
  });

  it("becomes true after hydration when the shell is there", async () => {
    installBridge(fakeBridge());

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId("desktop")).toHaveTextContent("true"));
  });
});

function ScreensProbe() {
  const { available, screens, busy } = useScreens();
  return (
    <div>
      <span data-testid="available">{String(available)}</span>
      <span data-testid="busy">{String(busy)}</span>
      <span data-testid="count">{screens.length}</span>
      <span data-testid="labels">{screens.map((s) => s.label).join(",")}</span>
    </div>
  );
}

describe("useScreens", () => {
  it("asks the shell for nothing in a browser and reports an empty, unavailable wall", async () => {
    render(<ScreensProbe />);

    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("false"));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    expect(screen.getByTestId("busy")).toHaveTextContent("false");
  });

  it("reads the layout from the shell and reports the screens on this desk", async () => {
    const bridge = fakeBridge();
    installBridge(bridge);

    render(<ScreensProbe />);

    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("labels")).toHaveTextContent("DELL U2720Q");
    expect(bridge.screensLayout).toHaveBeenCalled();
  });

  it("adopts the layout the shell pushes when a monitor is plugged in or unplugged", async () => {
    let push: ((l: ScreenLayout) => void) | undefined;
    installBridge(
      fakeBridge({
        onScreensChanged: (cb) => {
          push = cb;
          return () => {};
        },
      }),
    );

    render(<ScreensProbe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

    act(() => {
      push?.({ ...LAYOUT, screens: [] });
    });

    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });

  it("unsubscribes on unmount, so a shell push never lands on a dead wall page", async () => {
    const off = vi.fn();
    installBridge(fakeBridge({ onScreensChanged: () => off }));

    const { unmount } = render(<ScreensProbe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

    unmount();

    expect(off).toHaveBeenCalledTimes(1);
  });
});
