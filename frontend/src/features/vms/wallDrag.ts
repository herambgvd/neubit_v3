// WHAT A DROP ON A WALL TILE MEANS (SCRUM-336).
//
// A tile is dropped on another tile to rearrange the wall, and a camera — or a
// whole recorder — is dropped on a tile from the rail. A station with a live view
// on each monitor adds a third source: ANOTHER WINDOW. The operator drags a tile
// off the main wall onto the screen beside it, which every VMS client allows
// (Genetec, Nx, Milestone).
//
// The browser already carried that drag between windows — as a tile index, which
// the receiving wall read as one of ITS tiles, swapping two unrelated cells there.
// So a tile drag now also carries its camera, and a mark naming the window it
// left. Only a tile of this window rearranges; one from anywhere else lands as its
// camera, and the tile it came from stays where it was.

export const TILE_INDEX_TYPE = "text/tile-index";
export const CAMERA_ID_TYPE = "text/camera-id";
export const CAMERA_IDS_TYPE = "text/camera-ids";

/** Random per page load. Hex because a drag's types reach the target lowercased;
 *  getRandomValues because it works on a plain-http LAN address, where
 *  randomUUID does not exist. */
function windowId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Marks a drag as a tile of THIS window's wall. A type rather than data, because
 *  a dragover may read the types and not the data. */
export const OWN_WALL_TYPE = `application/x-neubit-wall-${windowId()}`;

/** Begin dragging a filled tile. Both effects are allowed — a move within this
 *  wall, a copy into another — and the drop target picks (dragEffect). */
export function startTileDrag(dt: DataTransfer, index: number, cameraId: string): void {
  dt.setData(TILE_INDEX_TYPE, String(index));
  dt.setData(CAMERA_ID_TYPE, cameraId);
  dt.setData(OWN_WALL_TYPE, "1");
  dt.effectAllowed = "copyMove";
}

/** What a drag over a tile would do, or null when it carries nothing a tile takes.
 *
 *  It must agree with the source's effectAllowed: a mismatch resolves to "none" and
 *  the browser refuses the drop silently, after the tile has already lit up. */
export function dragEffect(types: readonly string[]): "move" | "copy" | null {
  if (types.includes(TILE_INDEX_TYPE) && types.includes(OWN_WALL_TYPE)) return "move";
  if (types.includes(CAMERA_ID_TYPE) || types.includes(CAMERA_IDS_TYPE)) return "copy";
  return null;
}

export type TileDrop =
  | { kind: "swap"; from: number }
  | { kind: "many"; ids: string[] }
  | { kind: "one"; id: string }
  | null;

/** What a drop on tile `index` asks for. */
export function readDrop(dt: Pick<DataTransfer, "types" | "getData">, index: number): TileDrop {
  if (dt.types.includes(OWN_WALL_TYPE)) {
    const from = dt.getData(TILE_INDEX_TYPE);
    return from !== "" && from !== String(index) ? { kind: "swap", from: Number(from) } : null;
  }
  // A whole branch: fill from THIS tile onward, so where the operator dropped
  // decides where the recorder lands rather than always the top-left.
  const many = parseIds(dt.getData(CAMERA_IDS_TYPE));
  if (many.length) return { kind: "many", ids: many };
  const id = dt.getData(CAMERA_ID_TYPE);
  return id ? { kind: "one", id } : null;
}

/** The rail serialises a branch as a JSON array of camera ids. A malformed payload
 *  is not worth failing a drop over: it reads as no branch at all. */
function parseIds(raw: string): string[] {
  if (!raw) return [];
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string" && v !== "") : [];
  } catch {
    return [];
  }
}
