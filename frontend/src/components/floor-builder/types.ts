// Floor-builder domain types — what the editor, canvas, sidebars and renderer
// pass between themselves. Separate from lib/types (the wire shapes) because
// the editor holds MORE than the wire does: draft zones that have no server id
// yet, placements flattened to x/y/rotation for the canvas, and the joined-in
// device name a placement row never carries.
import type {
  DevicePlacementPublic,
  DeviceType,
  FloorPosition,
  ServiceType,
  ThreatLevel,
  ZonePublic,
  ZoneType,
} from "@/lib/types";

import type { EDITOR_MODES, TOOL_TYPES } from "./constants";

export type EditorMode = (typeof EDITOR_MODES)[keyof typeof EDITOR_MODES];
export type ToolType = (typeof TOOL_TYPES)[keyof typeof TOOL_TYPES];

/** A point in floor-plan space (the units the polygon is drawn in). */
export interface FloorPoint {
  x: number;
  y: number;
}

/** A zone as the editor holds it: a saved `ZonePublic`, or a draft (id
 *  `draft_*`, `is_draft`) that persists on Save. */
export interface EditorZone extends Omit<Partial<ZonePublic>, "max_occupancy"> {
  zone_id: string;
  name: string;
  /** "" while being typed in the properties form; null = no limit. */
  max_occupancy?: number | string | null;
  is_draft?: boolean;
}

/** What the zone properties form saves back onto a zone. */
export interface ZonePatch {
  name: string;
  description: string | null;
  zone_type: ZoneType;
  threat_level: ThreatLevel;
  color: string;
  max_occupancy: number | null;
  alert_on_entry: boolean;
  alert_on_exit: boolean;
}

/** A placement as the editor holds it: `floor_position` flattened to
 *  x/y/rotation so the canvas reads them directly, plus the name joined back
 *  from the inventory (a placement row is id-only). */
export interface EditorPlacement
  extends Partial<Omit<DevicePlacementPublic, "device_id" | "device_type" | "service" | "floor_position">> {
  device_id: string;
  device_type: DeviceType;
  service: ServiceType;
  floor_position?: FloorPosition;
  x: number;
  y: number;
  rotation: number;
  name?: string;
  label?: string;
  is_draft?: boolean;
}

/** An entry in the palette — one device the operator can drag onto the plan. */
export interface PlaceableDevice {
  device_id: string;
  name: string;
  device_type: DeviceType;
  service: ServiceType;
  /** Secondary search text (an IP / host); "" when the source has none. */
  search_ip: string;
  /** BI classification for IoT devices — see useDeviceInventory. */
  iot_category?: string | null;
  iot_type?: string | null;
  points?: number;
  /** Persisted with the pin so the plan keeps drawing the right glyph. */
  metadata?: Record<string, unknown> | null;
}

/** The JSON a palette row puts on the drag — what lands on the canvas. */
export interface DevicePayload {
  device_id: string;
  device_type: DeviceType;
  service: ServiceType;
  name?: string;
  metadata?: Record<string, unknown> | null;
}
