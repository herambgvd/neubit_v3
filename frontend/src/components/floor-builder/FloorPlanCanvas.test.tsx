// The keyboard path across the floor plan.
//
// The canvas is one coordinate space with nothing inside it to tab to, so these
// keys are the whole of it for anybody without a pointer: they have to pan, zoom
// and — the part that has no equivalent anywhere else in the editor — place the
// points of a zone polygon. The rules they must keep: a key the canvas does not
// claim is LEFT ALONE, so Tab still leaves and the editor above keeps Ctrl+Z;
// Enter and Escape stay with the window-level draft handler that already owns
// them; and the arrows mean crosshair while drawing and pan the rest of the time.
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EDITOR_MODES, TOOL_TYPES } from "./constants";
import {
  canvasKeyAction,
  FloorPlanCanvas,
  isPointInDeviceFov,
  pointInAnyZone,
  pointInPolygon,
  rotationHandleWorld,
  type FloorPlanCanvasHandle,
} from "./FloorPlanCanvas";
import type { EditorPlacement, EditorZone } from "./types";

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

// ── The plan's geometry ───────────────────────────────────────────────
//
// These four functions decide, between them, everything the canvas claims about
// where things are: which zone a point falls in (so a click selects the right
// one), whether a dropped device landed inside a zone at all, where a camera's
// rotate grip sits, and what its cone covers. All of it is arithmetic, and a
// wrong answer here shows up as a click that selects nothing, a grip that cannot
// be grabbed where the cursor says it can, or a device dropped into a wall.
describe("pointInPolygon", () => {
  const square = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];

  it("separates inside from outside", () => {
    expect(pointInPolygon([50, 50], square)).toBe(true);
    expect(pointInPolygon([150, 50], square)).toBe(false);
    // Level with the square but off to the left: a naive bounding-box check
    // would call this a hit.
    expect(pointInPolygon([-10, 50], square)).toBe(false);
    expect(pointInPolygon([50, 150], square)).toBe(false);
  });

  it("respects a concave shape rather than its hull", () => {
    // An L: the notch in the top-right corner is OUTSIDE the zone even though it
    // is well inside the shape's bounding box. Zones are drawn around furniture
    // and corridors, so concave is the normal case, not the exotic one.
    const ell = [
      [0, 0],
      [50, 0],
      [50, 50],
      [100, 50],
      [100, 100],
      [0, 100],
    ];
    expect(pointInPolygon([25, 25], ell)).toBe(true);
    expect(pointInPolygon([75, 25], ell)).toBe(false);
    expect(pointInPolygon([75, 75], ell)).toBe(true);
  });
});

describe("pointInAnyZone", () => {
  const zone = (zone_id: string, x: number): EditorZone => ({
    zone_id,
    name: zone_id,
    polygon: [
      [x, 0],
      [x + 50, 0],
      [x + 50, 50],
      [x, 50],
    ],
  });

  it("is true for a point in any one of the zones, false in the gaps", () => {
    const zones = [zone("a", 0), zone("b", 100)];
    expect(pointInAnyZone([25, 25], zones)).toBe(true);
    expect(pointInAnyZone([125, 25], zones)).toBe(true);
    expect(pointInAnyZone([75, 25], zones)).toBe(false);
  });

  it("ignores a zone that is not yet a shape", () => {
    // A polygon still being drawn (or a zone saved with a bad shape) has no
    // inside. Treating one as a drop target would let a device land nowhere.
    expect(
      pointInAnyZone([25, 25], [{ zone_id: "half", name: "half", polygon: [[0, 0], [50, 50]] }]),
    ).toBe(false);
    expect(pointInAnyZone([25, 25], [])).toBe(false);
    expect(pointInAnyZone([25, 25])).toBe(false);
  });
});

describe("rotationHandleWorld", () => {
  it("puts the grip in front of the camera, 28 SCREEN px out", () => {
    // Rotation 0 is north, and the canvas's y grows downward — so the grip of an
    // unrotated camera sits above it.
    expect(rotationHandleWorld({ x: 100, y: 100, rotation: 0 }, 1)).toEqual([100, 72]);
    // Turned to face east, the grip goes with it.
    const [hx, hy] = rotationHandleWorld({ x: 100, y: 100, rotation: 90 }, 1);
    expect(hx).toBeCloseTo(128);
    expect(hy).toBeCloseTo(100);
  });

  it("shrinks in world units as the plan is zoomed in", () => {
    // The offset is divided by the scale so the grip stays a constant, grabbable
    // 28px on screen at every zoom. Drop the /scale and the grip drifts away from
    // the camera the further in you zoom, while the cursor still promises it.
    expect(rotationHandleWorld({ x: 100, y: 100, rotation: 0 }, 2)).toEqual([100, 86]);
    expect(rotationHandleWorld({ x: 100, y: 100, rotation: 0 }, 0.5)).toEqual([100, 44]);
  });

  it("treats a device with no position or rotation as an unrotated origin", () => {
    const [hx, hy] = rotationHandleWorld({}, 1);
    expect(hx).toBeCloseTo(0);
    expect(hy).toBeCloseTo(-28);
  });
});

describe("isPointInDeviceFov", () => {
  // A camera at the origin looking north, with the renderer's defaults.
  const cam = { x: 0, y: 0, rotation: 0, fov: 70, coverage_radius: 60 };

  it("covers what is in front of the lens and nothing behind it", () => {
    expect(isPointInDeviceFov(cam, [0, -40])).toBe(true); // straight ahead
    expect(isPointInDeviceFov(cam, [0, 40])).toBe(false); // directly behind
    expect(isPointInDeviceFov(cam, [40, 0])).toBe(false); // off to the side
  });

  it("stops at the coverage radius", () => {
    expect(isPointInDeviceFov(cam, [0, -59])).toBe(true);
    expect(isPointInDeviceFov(cam, [0, -61])).toBe(false);
  });

  it("opens exactly half the fov either side of the facing", () => {
    // 35° off north is the edge of a 70° cone; 36° is past it.
    const at = (deg: number, r = 40): [number, number] => {
      const a = ((deg - 90) * Math.PI) / 180;
      return [Math.cos(a) * r, Math.sin(a) * r];
    };
    expect(isPointInDeviceFov(cam, at(34))).toBe(true);
    expect(isPointInDeviceFov(cam, at(-34))).toBe(true);
    expect(isPointInDeviceFov(cam, at(36))).toBe(false);
    expect(isPointInDeviceFov(cam, at(-36))).toBe(false);
  });

  it("works for a camera pointed across the 0/360 seam", () => {
    // Facing 350°, a point due north is 10° off — inside the cone. Without the
    // angle normalisation the difference comes out as 350° and the whole cone
    // reads as empty for any camera turned past north.
    expect(isPointInDeviceFov({ ...cam, rotation: 350 }, [0, -40])).toBe(true);
    expect(isPointInDeviceFov({ ...cam, rotation: 10 }, [0, -40])).toBe(true);
  });
});

// ── The canvas as the operator drives it ──────────────────────────────
//
// jsdom gives an element no layout and getBoundingClientRect() all zeros, so a
// client coordinate IS a canvas coordinate here; the box below is what the view
// maths (centre, fit, crosshair clamp) is measured against.
const withBox = () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  });
  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });
};

const ZONE: EditorZone = {
  zone_id: "z1",
  name: "Lobby",
  color: "#2563eb",
  polygon: [
    [0, 0],
    [400, 0],
    [400, 400],
    [0, 400],
  ],
};

const surface = () => screen.getByLabelText(/floor plan/i);

describe("drawing a zone with the mouse", () => {
  withBox();

  const drawMode = {
    editorMode: EDITOR_MODES.ZONE_DRAW,
    activeTool: TOOL_TYPES.ZONE_POLYGON,
  } as const;

  it("adds a point per click and closes when a click lands back on the first", () => {
    const onZoneCreate = vi.fn();
    render(<FloorPlanCanvas {...drawMode} onZoneCreate={onZoneCreate} />);

    fireEvent.mouseDown(surface(), { clientX: 100, clientY: 100 });
    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 100 });
    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 200 });
    // Three points down and none of them closed the shape.
    expect(onZoneCreate).not.toHaveBeenCalled();

    // Near enough to the first corner (8px) to count as closing it.
    fireEvent.mouseDown(surface(), { clientX: 105, clientY: 105 });
    expect(onZoneCreate).toHaveBeenCalledTimes(1);
    expect(onZoneCreate.mock.calls[0][0]).toEqual([
      [100, 100],
      [200, 100],
      [200, 200],
    ]);
  });

  it("takes a click near the first corner as a fourth point until there are three", () => {
    // With only two points down there is no polygon to close, so the closing
    // gesture has to mean what every other click means.
    const onZoneCreate = vi.fn();
    render(<FloorPlanCanvas {...drawMode} onZoneCreate={onZoneCreate} />);

    fireEvent.mouseDown(surface(), { clientX: 100, clientY: 100 });
    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 100 });
    fireEvent.mouseDown(surface(), { clientX: 102, clientY: 100 });
    expect(onZoneCreate).not.toHaveBeenCalled();

    // ...and now that there are three, the same click closes.
    fireEvent.mouseDown(surface(), { clientX: 100, clientY: 100 });
    expect(onZoneCreate.mock.calls[0][0]).toHaveLength(3);
  });

  it("cancels on Escape and closes on Enter, which the window owns", () => {
    // These two are handled at the window, not on the canvas, so they work while
    // focus is in the properties form beside the plan.
    const onZoneCreate = vi.fn();
    render(<FloorPlanCanvas {...drawMode} onZoneCreate={onZoneCreate} />);

    fireEvent.mouseDown(surface(), { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(surface(), { clientX: 20, clientY: 10 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onZoneCreate).not.toHaveBeenCalled(); // the draft was discarded

    fireEvent.mouseDown(surface(), { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(surface(), { clientX: 20, clientY: 10 });
    fireEvent.mouseDown(surface(), { clientX: 20, clientY: 20 });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onZoneCreate).toHaveBeenCalledTimes(1);
    expect(onZoneCreate.mock.calls[0][0]).toEqual([
      [10, 10],
      [20, 10],
      [20, 20],
    ]);
  });
});

describe("the imperative handle the editor drives", () => {
  withBox();

  it("only finishes a draft that is already a polygon, and cancels any", () => {
    // The toolbar's Finish button is live whenever a draft exists; two points are
    // not a zone, and committing one would save a shape with no inside.
    const onZoneCreate = vi.fn();
    const ref = { current: null as FloorPlanCanvasHandle | null };
    render(
      <FloorPlanCanvas
        ref={ref}
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );

    fireEvent.mouseDown(surface(), { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(surface(), { clientX: 60, clientY: 10 });
    act(() => ref.current!.finishDraft());
    expect(onZoneCreate).not.toHaveBeenCalled();

    fireEvent.mouseDown(surface(), { clientX: 60, clientY: 60 });
    act(() => ref.current!.finishDraft());
    expect(onZoneCreate).toHaveBeenCalledTimes(1);

    // Finishing clears the draft, so the button cannot commit the same zone twice.
    act(() => ref.current!.finishDraft());
    expect(onZoneCreate).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(surface(), { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(surface(), { clientX: 60, clientY: 10 });
    fireEvent.mouseDown(surface(), { clientX: 60, clientY: 60 });
    act(() => ref.current!.cancelDraft());
    act(() => ref.current!.finishDraft());
    expect(onZoneCreate).toHaveBeenCalledTimes(1);
  });
});

describe("moving the view", () => {
  withBox();

  const drawAt = (x: number, y: number) => fireEvent.mouseDown(surface(), { clientX: x, clientY: y });

  /** The one thing the view transform is FOR: a press at a screen point has to
   *  land on the world point the operator believes is under the cursor. Reading
   *  it back out of the polygon is how a test can see that from outside. */
  const worldUnderClick = (onZoneCreate: ReturnType<typeof vi.fn>, x: number, y: number) => {
    drawAt(x, y);
    drawAt(x + 40, y);
    drawAt(x + 40, y + 40);
    fireEvent.keyDown(window, { key: "Enter" });
    return onZoneCreate.mock.calls.at(-1)![0][0] as number[];
  };

  it("pans with an alt-drag, and clicks follow the plan", () => {
    const onZoneCreate = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );

    // Alt pans from anywhere — including, here, in the middle of drawing.
    fireEvent.mouseDown(surface(), { clientX: 300, clientY: 300, altKey: true });
    fireEvent.mouseMove(surface(), { clientX: 350, clientY: 330 });
    fireEvent.mouseUp(surface());

    // The plan slid 50 right and 30 down under a fixed viewport, so the pixel
    // that was at 100,100 is now at 150,130.
    expect(worldUnderClick(onZoneCreate, 150, 130)).toEqual([100, 100]);
  });

  it("zooms about the cursor, keeping what is under it put", () => {
    const onZoneCreate = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );

    // Wheel up over 200,200: whatever world point was there must still be there
    // afterwards, which is the whole promise of zoom-at-cursor.
    fireEvent.wheel(surface(), { clientX: 200, clientY: 200, deltaY: -100 });
    expect(worldUnderClick(onZoneCreate, 200, 200)).toEqual([200, 200]);

    // And a point one screen-pixel away has moved in by the 1.1 zoom factor.
    const [nx] = worldUnderClick(onZoneCreate, 310, 200);
    expect(nx).toBeCloseTo(200 + 110 / 1.1);
  });

  it("zooms about the middle of the view from the keyboard", () => {
    // The +/- keys have no cursor to zoom about, so they use the centre of the
    // 800x600 box — the only point a keyboard operator can be sure stays put.
    const onZoneCreate = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );

    fireEvent.keyDown(surface(), { key: "+" });
    expect(worldUnderClick(onZoneCreate, 400, 300)).toEqual([400, 300]);
    const [nx] = worldUnderClick(onZoneCreate, 520, 300);
    expect(nx).toBeCloseTo(400 + 120 / 1.2);
  });
});

describe("selecting a zone", () => {
  withBox();

  it("selects the zone under the press, and pans off an empty plan", () => {
    const onSelectZone = vi.fn();
    render(
      <FloorPlanCanvas editorMode={EDITOR_MODES.ZONE_EDIT} zones={[ZONE]} onSelectZone={onSelectZone} />,
    );
    const plan = surface().parentElement!;

    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 200 });
    expect(onSelectZone).toHaveBeenCalledWith(ZONE);
    // A press inside a zone grabs the zone, not the view.
    expect(plan).toHaveStyle({ cursor: "grab" });

    fireEvent.mouseUp(surface());
    fireEvent.mouseDown(surface(), { clientX: 600, clientY: 500 });
    expect(onSelectZone).toHaveBeenCalledTimes(1);
    // Outside every zone the press is a pan instead — the cursor says so.
    expect(plan).toHaveStyle({ cursor: "grabbing" });
  });
});

describe("dropping a device from the palette", () => {
  withBox();

  // The palette writes one of two mime types; dataTransfer is not implemented in
  // jsdom, and during dragover a real browser will not let getData() be read at
  // all — hence the split between `types` (readable) and `getData` (not).
  const transfer = (payload?: unknown) => ({
    types: ["application/x-neubit-device"],
    dropEffect: "",
    getData: (type: string) =>
      type === "application/x-neubit-device" && payload !== undefined ? JSON.stringify(payload) : "",
  });

  // jsdom has no DragEvent, and fireEvent's fallback drops the pointer position
  // with it — which would put every drag at NaN,NaN and make this whole section
  // pass for the wrong reason. A MouseEvent named "dragover" carries the
  // coordinates and is all React's synthetic layer looks at.
  const drag = (
    type: "dragover" | "drop" | "dragleave",
    at: { clientX?: number; clientY?: number; relatedTarget?: Node },
    dataTransfer?: ReturnType<typeof transfer>,
  ) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
    if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    fireEvent(surface(), event);
  };

  const preview = {
    device_id: "cam-1",
    name: "Lobby cam",
    device_type: "camera",
    service: "vms",
    search_ip: "",
  } as const;

  const plan = (props: Partial<ComponentProps<typeof FloorPlanCanvas>> = {}) =>
    render(<FloorPlanCanvas zones={[ZONE]} dragPreview={preview} {...props} />);

  it("names the zone it would land in, and refuses the plan outside one", () => {
    plan();

    const inside = transfer();
    drag("dragover", { clientX: 200, clientY: 200 }, inside);
    expect(screen.getByText("Drop Lobby cam in Lobby")).toBeInTheDocument();
    expect(inside.dropEffect).toBe("copy");

    const outside = transfer();
    drag("dragover", { clientX: 600, clientY: 500 }, outside);
    expect(screen.getByText("Devices must be dropped inside a zone")).toBeInTheDocument();
    expect(outside.dropEffect).toBe("none");
  });

  it("ignores a drag that is not carrying a device", () => {
    // A file or a text selection dragged over the plan must not light it up.
    plan();
    const files = { ...transfer(), types: ["Files"] };
    drag("dragover", { clientX: 200, clientY: 200 }, files);
    expect(screen.queryByText(/^Drop /)).not.toBeInTheDocument();
    expect(files.dropEffect).toBe("");
  });

  it("hands the drop to the parent only when it lands in a zone", () => {
    const onDeviceDrop = vi.fn();
    const onInvalidDrop = vi.fn();
    plan({ onDeviceDrop, onInvalidDrop });

    drag("drop", { clientX: 600, clientY: 500 }, transfer(preview));
    expect(onInvalidDrop).toHaveBeenCalledTimes(1);
    expect(onDeviceDrop).not.toHaveBeenCalled();

    drag("drop", { clientX: 250, clientY: 150 }, transfer(preview));
    expect(onInvalidDrop).toHaveBeenCalledTimes(1);
    expect(onDeviceDrop).toHaveBeenCalledWith({
      payload: preview,
      point: { x: 250, y: 150 },
    });
  });

  it("clears the ghost when the drag leaves the plan", () => {
    plan();
    drag("dragover", { clientX: 200, clientY: 200 }, transfer());
    expect(screen.getByText(/^Drop /)).toBeInTheDocument();

    // A dragleave onto something still inside the container is not a departure.
    drag("dragleave", { relatedTarget: surface() });
    expect(screen.getByText(/^Drop /)).toBeInTheDocument();

    drag("dragleave", { relatedTarget: document.body });
    expect(screen.queryByText(/^Drop /)).not.toBeInTheDocument();
  });
});

// ── Device editing: retained, not reachable ───────────────────────────
//
// The editor never puts the canvas in DEVICE_PLACE and always passes devices=[]
// (see the file header) — nothing below describes something an operator can do
// today. It is here because the code is still in the file and its two rules are
// the ones that will be wrong if it is ever switched on untested: a device may
// not be dragged out of its zone, and rotation follows the pointer in the
// device's own north-is-zero frame, not the canvas's east-is-zero one.
describe("device move and rotate (dormant paths, driven through the props)", () => {
  withBox();

  const device = (over: Partial<EditorPlacement> = {}): EditorPlacement => ({
    device_id: "cam-1",
    device_type: "camera",
    service: "vms",
    x: 200,
    y: 200,
    rotation: 0,
    ...over,
  });

  it("stops a dragged device at the edge of the zones instead of losing it", () => {
    const dev = device();
    const onDeviceMove = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.DEVICE_PLACE}
        activeTool={TOOL_TYPES.SELECT}
        zones={[ZONE]}
        devices={[dev]}
        onDeviceMove={onDeviceMove}
      />,
    );

    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(surface(), { clientX: 300, clientY: 300 });
    // Past the zone's 400x400 edge: the device holds its last legal position
    // rather than following the pointer out onto bare plan.
    fireEvent.mouseMove(surface(), { clientX: 600, clientY: 550 });
    fireEvent.mouseUp(surface());

    expect(onDeviceMove).toHaveBeenCalledWith(dev, { x: 300, y: 300 });
  });

  it("reports a press that never moved as a click, not a move", () => {
    const dev = device();
    const onDeviceMove = vi.fn();
    const onDeviceClick = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.DEVICE_PLACE}
        activeTool={TOOL_TYPES.SELECT}
        zones={[ZONE]}
        devices={[dev]}
        onDeviceMove={onDeviceMove}
        onDeviceClick={onDeviceClick}
      />,
    );

    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(surface());
    expect(onDeviceClick).toHaveBeenCalledWith(dev);
    expect(onDeviceMove).not.toHaveBeenCalled();
  });

  it("turns a selected camera to face the pointer when its cone is grabbed", () => {
    const dev = device(); // no fov/coverage on a placement: the 70°/60px defaults apply
    const onDeviceRotate = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.DEVICE_PLACE}
        activeTool={TOOL_TYPES.SELECT}
        zones={[ZONE]}
        devices={[dev]}
        selectedDeviceId="cam-1"
        onDeviceRotate={onDeviceRotate}
      />,
    );

    // 40px north of the camera is inside the cone it is currently pointing down.
    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 160 });
    // Drag due east. In canvas angles that is 0; as a camera bearing it is 90.
    fireEvent.mouseMove(surface(), { clientX: 320, clientY: 200 });
    fireEvent.mouseUp(surface());

    expect(onDeviceRotate).toHaveBeenCalledWith(dev, 90);
  });

  it("does not rotate a camera that is not the selected one", () => {
    // The grip and the cone only belong to the selection; without that check a
    // press anywhere near any camera would spin it.
    const dev = device(); // no fov/coverage on a placement: the 70°/60px defaults apply
    const onDeviceRotate = vi.fn();
    render(
      <FloorPlanCanvas
        editorMode={EDITOR_MODES.DEVICE_PLACE}
        activeTool={TOOL_TYPES.SELECT}
        zones={[ZONE]}
        devices={[dev]}
        onDeviceRotate={onDeviceRotate}
      />,
    );

    fireEvent.mouseDown(surface(), { clientX: 200, clientY: 160 });
    fireEvent.mouseMove(surface(), { clientX: 320, clientY: 200 });
    fireEvent.mouseUp(surface());
    expect(onDeviceRotate).not.toHaveBeenCalled();
  });
});

describe("fitting the floor plan into the viewport", () => {
  withBox();

  // jsdom never loads an image, so nothing would ever set imgSize and the fit
  // maths below could not run at all. The stub is the smallest thing that makes
  // a floorplan "arrive": a known natural size, handed straight to onload.
  class LoadedImage {
    naturalWidth = 1600;
    naturalHeight = 1200;
    onload: (() => void) | null = null;
    set src(_value: string) {
      this.onload?.();
    }
  }

  beforeAll(() => vi.stubGlobal("Image", LoadedImage));
  afterAll(() => vi.unstubAllGlobals());

  // A 1600x1200 plan in an 800x600 box fits at 0.5, less the 5% margin the fit
  // leaves so the edges of the plan are visibly inside the viewport.
  const FIT = 0.5 * 0.95;
  const ORIGIN = [(800 - 1600 * FIT) / 2, (600 - 1200 * FIT) / 2]; // = [20, 15]

  const drawCornerAt = (onZoneCreate: ReturnType<typeof vi.fn>, x: number, y: number) => {
    fireEvent.mouseDown(surface(), { clientX: x, clientY: y });
    fireEvent.mouseDown(surface(), { clientX: x + 40, clientY: y });
    fireEvent.mouseDown(surface(), { clientX: x + 40, clientY: y + 40 });
    fireEvent.keyDown(window, { key: "Enter" });
    return onZoneCreate.mock.calls.at(-1)![0][0] as number[];
  };

  it("centres the loaded plan and leaves a margin round it", () => {
    const onZoneCreate = vi.fn();
    render(
      <FloorPlanCanvas
        floorplanUrl="plan.png"
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );
    // The plan's top-left pixel sits at the offset the fit computed, so a click
    // there is world 0,0 — the plan is inside the viewport, not hanging off it.
    const [x, y] = drawCornerAt(onZoneCreate, ORIGIN[0], ORIGIN[1]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it("puts the plan back with 0, and with resetView from the editor", () => {
    const onZoneCreate = vi.fn();
    const ref = { current: null as FloorPlanCanvasHandle | null };
    render(
      <FloorPlanCanvas
        ref={ref}
        floorplanUrl="plan.png"
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );

    // Lost: panned far off and zoomed in. Both of these are the way back.
    fireEvent.mouseDown(surface(), { clientX: 400, clientY: 300, altKey: true });
    fireEvent.mouseMove(surface(), { clientX: 900, clientY: 800 });
    fireEvent.mouseUp(surface());
    fireEvent.wheel(surface(), { clientX: 400, clientY: 300, deltaY: -100 });

    fireEvent.keyDown(surface(), { key: "0" });
    expect(drawCornerAt(onZoneCreate, ORIGIN[0], ORIGIN[1])[0]).toBeCloseTo(0);

    fireEvent.mouseDown(surface(), { clientX: 400, clientY: 300, altKey: true });
    fireEvent.mouseMove(surface(), { clientX: 900, clientY: 800 });
    fireEvent.mouseUp(surface());

    act(() => ref.current!.resetView());
    expect(drawCornerAt(onZoneCreate, ORIGIN[0], ORIGIN[1])[0]).toBeCloseTo(0);
  });

  it("never blows a small plan up past 1:1", () => {
    // A 100x80 sketch fitted to an 800x600 box would be a wall of interpolation.
    class SmallImage extends LoadedImage {
      naturalWidth = 100;
      naturalHeight = 80;
    }
    vi.stubGlobal("Image", SmallImage);
    const onZoneCreate = vi.fn();
    render(
      <FloorPlanCanvas
        floorplanUrl="sketch.png"
        editorMode={EDITOR_MODES.ZONE_DRAW}
        activeTool={TOOL_TYPES.ZONE_POLYGON}
        onZoneCreate={onZoneCreate}
      />,
    );
    // Scale capped at 1 (x0.95), so 40 screen px is ~42 world px, not 400.
    const origin = [(800 - 100 * 0.95) / 2, (600 - 80 * 0.95) / 2];
    const [x] = drawCornerAt(onZoneCreate, origin[0] + 40, origin[1]);
    expect(x).toBeCloseTo(40 / 0.95);
  });
});
