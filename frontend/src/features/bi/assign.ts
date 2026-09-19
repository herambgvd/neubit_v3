// ASSIGNING DEVICES TO A BUILDING — the model behind gate 3's worklist.
//
// A device's building is an OPERATOR'S ASSERTION about a physical box. So this
// file holds the three rules that make the write sound, and nothing that could
// make it for anyone:
//
//   • the body names exactly the devices a person ticked, and the site they
//     picked. There is no predicate form and no default site — not even when
//     the estate has exactly one, which is the guess this platform refuses;
//   • a floor is optional and a pin is never asked for. "This meter is in Aeon
//     Tower" is a whole statement; demanding an {x, y} for it would make the
//     operator invent a coordinate or say nothing;
//   • every outcome comes back per device and is shown per device, including
//     `pin_cleared` — the only signal that a move dropped a floor-plan pin.
import type { AssignDevicesRequest, AssignedDevice, BiDeviceRow } from "@/lib/types";

/** A device with no id cannot be named in a placement — `device_placements` is
 *  keyed by it. It is still LISTED (it is still unplaced), just not tickable. */
export const assignable = (d: Pick<BiDeviceRow, "device_id">): boolean => !!d.device_id;

/** The request body, from exactly what the operator chose.
 *
 *  `device_type: "sensor"`, `service: "iot"` are not a guess about the device:
 *  they are how this platform has always placed a reporting device (the floor
 *  plan's IoT palette does the same, lib/api/deviceInventory.ts), and core
 *  refuses a new placement without them. BI's own `device_type` (`chiller`,
 *  `meter`) is the EQUIPMENT kind and is not the placement enum.
 *
 *  Returns null when there is nothing to send — no site, or no device — so a
 *  caller cannot post a request the operator has not finished stating. */
export function assignBody(
  devices: readonly Pick<BiDeviceRow, "device_id">[],
  siteId: string | null | undefined,
  floorId?: string | null,
): AssignDevicesRequest | null {
  if (!siteId) return null;
  const ids: string[] = [];
  for (const d of devices) {
    if (d.device_id && !ids.includes(d.device_id)) ids.push(d.device_id);
  }
  if (!ids.length) return null;
  return {
    site_id: siteId,
    device_type: "sensor",
    service: "iot",
    devices: ids.map((device_id) => (floorId ? { device_id, floor_id: floorId } : { device_id })),
  };
}

/** Every read an assignment makes stale. The gate strip reads `bi-summary` (the
 *  gate 3 count) and `bi-devices` (its rows, this worklist, the IoT tab's
 *  building line); `bi-points` carries the site per point; the two placement
 *  reads are the map's and the floor plan palette's. */
export const ASSIGN_INVALIDATES: readonly (readonly string[])[] = [
  ["bi-summary"],
  ["bi-devices"],
  ["bi-points"],
  ["device-placements-index"],
  ["floor-builder", "iot-devices"],
];

export type OutcomeTone = "good" | "warn";

export interface OutcomeView {
  deviceId: string;
  tag: string;
  /** assigned · moved from X · re-stated */
  verb: string;
  /** The floor it now sits on, or null for "site only". */
  floor: string | null;
  pinCleared: boolean;
  tone: OutcomeTone;
}

/** One device's outcome, in words, from the server's answer and the row the
 *  operator saw. A pin that was dropped is WARN, because it is the one outcome
 *  that removed something the operator did not name. */
export function outcomeView(
  item: AssignedDevice,
  before: Pick<BiDeviceRow, "device_tag" | "site_id" | "site_name"> | undefined,
  floorName: (id: string) => string | null,
): OutcomeView {
  let verb = "assigned";
  if (!item.created) {
    verb =
      before?.site_id && before.site_id !== item.site_id
        ? `moved from ${before.site_name || "another building"}`
        : "re-stated";
  }
  return {
    deviceId: item.device_id,
    tag: before?.device_tag || item.device_id,
    verb,
    floor: item.floor_id ? floorName(item.floor_id) || "a floor" : null,
    pinCleared: !!item.pin_cleared,
    tone: item.pin_cleared ? "warn" : "good",
  };
}
