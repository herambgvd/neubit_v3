// The keyboard path across the floor plan.
//
// The canvas is one coordinate space with nothing inside it to tab to, so these
// keys are the whole of it for anybody without a pointer: they have to pan, zoom
// and — the part that has no equivalent anywhere else in the editor — place the
// points of a zone polygon. The rules they must keep: a key the canvas does not
// claim is LEFT ALONE, so Tab still leaves and the editor above keeps Ctrl+Z;
// Enter and Escape stay with the window-level draft handler that already owns
// them; and the arrows mean crosshair while drawing and pan the rest of the time.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EDITOR_MODES, TOOL_TYPES } from "./constants";
import { canvasKeyAction, FloorPlanCanvas } from "./FloorPlanCanvas";

const drawing = { drawing: true, draftCount: 0 };
const idle = { drawing: false, draftCount: 0 };
const none = {};

describe("canvasKeyAction", () => {
  it("pans with the arrows when nothing is being drawn", () => {
    // The offset moves against the key: ArrowRight looks further right.
    expect(canvasKeyAction("ArrowRight", none, idle)).toEqual({ kind: "pan", dx: -48, dy: 0 });
    expect(canvasKeyAction("ArrowUp", none, idle)).toEqual({ kind: "pan", dx: 0, dy: 48 });
    expect(canvasKeyAction("ArrowLeft", { shiftKey: true }, idle)).toEqual({
      kind: "pan",
      dx: 192,
      dy: 0,
    });
  });

  it("moves the crosshair instead while a polygon is being drawn", () => {
    expect(canvasKeyAction("ArrowRight", none, drawing)).toEqual({ kind: "cursor", dx: 8, dy: 0 });
    // Shift is the fine step — a point usually wants to land exactly on a wall.
    expect(canvasKeyAction("ArrowDown", { shiftKey: true }, drawing)).toEqual({
      kind: "cursor",
      dx: 0,
      dy: 1,
    });
  });

  it("still pans with Alt held, the modifier that pans with the mouse", () => {
    expect(canvasKeyAction("ArrowRight", { altKey: true }, drawing)).toEqual({
      kind: "pan",
      dx: -48,
      dy: 0,
    });
  });

  it("places and takes back points only while drawing", () => {
    expect(canvasKeyAction(" ", none, drawing)).toEqual({ kind: "addPoint" });
    expect(canvasKeyAction(" ", none, idle)).toBeNull();
    expect(canvasKeyAction("Backspace", none, { drawing: true, draftCount: 2 })).toEqual({
      kind: "undoPoint",
    });
    // Nothing to take back yet — leave Backspace to whatever else wants it.
    expect(canvasKeyAction("Backspace", none, drawing)).toBeNull();
  });

  it("zooms and fits, which the mouse can only do by wheel", () => {
    expect(canvasKeyAction("+", none, idle)).toEqual({ kind: "zoom", factor: 1.2 });
    expect(canvasKeyAction("-", none, idle)).toEqual({ kind: "zoom", factor: 1 / 1.2 });
    expect(canvasKeyAction("0", none, idle)).toEqual({ kind: "fit" });
  });

  it("does not claim keys that belong to somebody else", () => {
    // null is what tells the handler to skip preventDefault. Tab must leave the
    // canvas or the operator is stuck on it; Enter and Escape are the window-level
    // draft handler's, and claiming them here would close a zone twice.
    for (const key of ["Tab", "Enter", "Escape", "a", "PageDown", "Home"]) {
      expect(canvasKeyAction(key, none, drawing)).toBeNull();
    }
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(canvasKeyAction("ArrowRight", mods, drawing)).toBeNull();
      expect(canvasKeyAction("0", mods, idle)).toBeNull();
    }
  });
});

// jsdom has no layout, so the canvas would be a zero-by-zero box and every
// crosshair step would clamp onto the same pixel. A fixed 800x600 gives the
// world coordinates below something to be measured against.
const BOX = { width: 800, height: 600 };

describe("drawing a zone with the keyboard alone", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: BOX.width,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: BOX.height,
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  const plan = (onZoneCreate: (points: number[][]) => void) =>
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );

  const surface = () => screen.getByLabelText(/floor plan/i);
  const press = (key: string, times = 1) => {
    for (let i = 0; i < times; i++) fireEvent.keyDown(surface(), { key });
  };

  it("walks the crosshair, drops points, takes one back and closes the polygon", () => {
    const onZoneCreate = vi.fn();
    plan(onZoneCreate);

    // The crosshair starts in the middle of the view; at the default 1:1 with no
    // pan that is world [400, 300].
    press(" "); // first corner
    press("ArrowRight", 2); // +16px
    press(" "); // second corner
    press("ArrowUp", 2);
    press(" "); // a corner in the wrong place...
    press("Backspace"); // ...taken back
    press("ArrowDown", 4);
    press(" "); // third corner
    expect(onZoneCreate).not.toHaveBeenCalled();

    // Back onto the first corner — the mouse's closing gesture, done with keys.
    press("ArrowLeft", 2);
    press("ArrowUp", 2);
    press(" ");

    expect(onZoneCreate).toHaveBeenCalledTimes(1);
    expect(onZoneCreate.mock.calls[0][0]).toEqual([
      [400, 300],
      [416, 300],
      [416, 316],
    ]);
  });

  it("lets focus leave: Tab is never swallowed", () => {
    plan(vi.fn());
    const tab = fireEvent.keyDown(surface(), { key: "Tab" });
    // fireEvent returns false when a handler called preventDefault.
    expect(tab).toBe(true);
    const space = fireEvent.keyDown(surface(), { key: " " });
    expect(space).toBe(false); // ...whereas a key the canvas does claim is consumed
  });
});
