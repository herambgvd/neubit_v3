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

/** Playback at the read with the ANPR camera and every camera bound to it, in sync. */
export function anprInvestigateHref(cameraId: string, a: AnprOfEvent, occurredAt: string): string {
  const p = new URLSearchParams();
  for (const id of [cameraId, ...a.linkedCameraIds.filter((x) => x !== cameraId)]) p.append("camera", id);
  p.set("t", occurredAt);
  return `/playback?${p.toString()}`;
}

/** The stills of a read in the order an operator looks at them. */
export function anprStills(images: readonly string[]): string[] {
  return ["plate", "scene", "vehicle", "evidence"].filter((k) => images.includes(k));
}
