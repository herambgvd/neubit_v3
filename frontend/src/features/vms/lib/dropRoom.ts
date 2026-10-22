// Where a drop-up on a wall tile opens and how tall it may be, so the tile never clips it (SCRUM-338).

/** The room around an anchor inside the box that clips it, in px. */
export interface DropRoom {
  /** From the anchor's top up to the box's top. */
  above: number;
  /** From the anchor's bottom up to the box's top: the height a menu beside it has. */
  beside: number;
  /** From the anchor's left to the box's left: the width a menu beside it has. */
  besideWidth: number;
}

export interface DropPlacement {
  side: "above" | "left";
  maxHeight: number;
  width: number;
}

/** Marks the box a tile's menus must stay inside: the tile itself. */
export const DROP_BOUNDS_ATTR = "data-drop-bounds";
/** Kept clear between a menu and the box's edge. */
const EDGE_GAP_PX = 6;
/** Under ~six rows of room above, the menu opens beside the anchor instead. */
export const DROP_MIN_PX = 144;
/** Never squeezed shorter than two rows, even where the anchor itself is clipped. */
const FLOOR_PX = 48;
/** The narrowest a menu beside the anchor is squeezed to: a name still reads. */
const MIN_WIDTH_PX = 160;

/** Above while that fits a useful list, else beside the anchor on its left;
 *  unmeasured, above at full size. */
export function dropPlacement(room: DropRoom | null, width: number, wanted: number): DropPlacement {
  if (!room) return { side: "above", maxHeight: wanted, width };
  const besideFits = room.besideWidth >= Math.min(width, MIN_WIDTH_PX);
  if (room.above < DROP_MIN_PX && besideFits && room.beside > room.above) {
    return { side: "left", maxHeight: Math.min(wanted, room.beside), width: Math.min(width, room.besideWidth) };
  }
  return { side: "above", maxHeight: Math.max(FLOOR_PX, Math.min(wanted, room.above)), width };
}

/** `el`'s room inside its DROP_BOUNDS_ATTR box; null when there is none or nothing is laid out. */
export function measureDropRoom(el: Element | null): DropRoom | null {
  const box = el?.closest(`[${DROP_BOUNDS_ATTR}]`);
  if (!el || !box) return null;
  const a = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (b.height <= 0) return null;
  return {
    above: a.top - b.top - EDGE_GAP_PX,
    beside: a.bottom - b.top - EDGE_GAP_PX,
    besideWidth: a.left - b.left - EDGE_GAP_PX,
  };
}

/** The classes that put a drop-up on its side of the anchor. */
export const DROP_SIDE_CLASS: Record<DropPlacement["side"], string> = {
  above: "bottom-full right-0 mb-1.5",
  left: "bottom-0 right-full mr-1.5",
};
