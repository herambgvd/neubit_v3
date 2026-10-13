// ANPR plate reads on the VMS (SCRUM-324): what an "anpr" event from a paired
// recorder carries, in one place, so the event panel, the alarm card and the
// playback link read it the same way.

/** The plate summary an "anpr" event carries in raw.payload (the recorder's own). */
export interface AnprOfEvent {
  readId: string;
  nodeId: string;
  plate: string;
  noPlate: boolean;
  list: string;
  listLabel: string;
  confidence: number | null;
  linkedCameraIds: string[];
}

type EventLike = { event_type?: string | null; raw?: unknown };

export function anprOf(event: EventLike | null | undefined): AnprOfEvent | null {
  if (event?.event_type !== "anpr" || !event.raw || typeof event.raw !== "object") return null;
  const raw = event.raw as Record<string, unknown>;
  const payload = (raw.payload && typeof raw.payload === "object" ? raw.payload : {}) as Record<string, unknown>;
  const a = (payload.anpr && typeof payload.anpr === "object" ? payload.anpr : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const linked = Array.isArray(payload.linked_camera_ids)
    ? payload.linked_camera_ids.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  const plate = str(a.plate);
  return {
    readId: str(a.read_id),
    nodeId: str(raw.node_id),
    plate,
    noPlate: a.no_plate === true || !plate,
    list: str(a.list),
    listLabel: str(a.list_label),
    confidence: typeof a.confidence === "number" ? a.confidence : null,
    linkedCameraIds: linked,
  };
}

const LIST_LABEL: Record<string, string> = {
  block: "Block list",
  allow: "Allow list",
  visitor: "Visitor",
};

export function anprListLabel(list: string, label?: string): string {
  const base = LIST_LABEL[list] ?? "Not listed";
  return label ? `${base}: ${label}` : base;
}

export function anprListCls(list: string): string {
  if (list === "block") return "bg-red-500/10 text-red-400 border-red-500/30";
  if (list === "allow") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
  if (list === "visitor") return "bg-sky-500/10 text-sky-400 border-sky-500/30";
  return "bg-hover text-muted border-card-border";
}

export function confidencePct(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? "—" : `${Math.round(c * 100)}%`;
}

/** Confidence as a sentence for the details pane: many plate cameras never send one,
 *  and a bare dash reads like a fault. */
export function anprConfidenceText(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? "Not reported by the camera" : confidencePct(c);
}

/** "White Toyota car" out of whatever the camera reported; empty when it said nothing. */
export function anprVehicleText(read: { vehicle_color?: string; vehicle_brand?: string; vehicle_type?: string } | null | undefined): string {
  if (!read) return "";
  return [read.vehicle_color, read.vehicle_brand, read.vehicle_type].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
}

/** Playback at the read with the ANPR camera and every camera bound to it, in sync. */
export function anprInvestigateHref(cameraId: string, a: AnprOfEvent, occurredAt: string): string {
  const p = new URLSearchParams();
  for (const id of [cameraId, ...a.linkedCameraIds.filter((x) => x !== cameraId)]) p.append("camera", id);
  p.set("t", occurredAt);
  return `/playback?${p.toString()}`;
}

/** The picture of the read for the monitor pane: the whole scene first, the plate
 *  crop only when the camera kept nothing wider. */
export function anprSceneStill(images: readonly string[]): string | null {
  return ["scene", "evidence", "vehicle", "plate"].find((k) => images.includes(k)) ?? null;
}

/** The events page's free-text filter, client side for live rows: the same match the
 *  API makes on the title (case-insensitive, the typed text taken literally). */
export function matchesEventSearch(title: string | null | undefined, search: string): boolean {
  const q = search.trim().toLowerCase();
  return !q || (title ?? "").toLowerCase().includes(q);
}
