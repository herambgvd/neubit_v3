// THE EQUIPMENT DRAWING — what is saved and what is proposed, as one picture.
//
// Two reads make it: the PLANT (`/bi/sites/{id}/plant`, the registry as the
// reporting store mirrors it, each slot with its latest value) and the
// SUGGESTIONS (`/bi/sites/{id}/equipment/suggestions`, every device placed in
// the building with what it probably is). A saved piece of equipment is a
// SOLID node; a device the platform can propose and nobody has saved yet is a
// GHOST. Nothing here is written anywhere — this file only decides what is
// drawn, and where.
//
// THE POWER CHAIN IS A TREE. A saved meter hangs off its `fed_by_id`; a ghost
// hangs off the feeder the engine proposed, whether that feeder is saved or is
// itself a ghost. A meter with no feeder and nothing under it is not the top of
// the chain — it is "not hung under a feeder yet", and is drawn apart so the
// picture never implies a topology nobody stated.
import type { BiPlant, BiPlantEquipment } from "@/lib/types";

export type Kind = "chw_plant" | "power" | "air_handling" | "water";
export const KINDS: Kind[] = ["chw_plant", "power", "air_handling", "water"];

export const KIND_LABEL: Record<Kind, string> = {
  chw_plant: "Chilled water",
  power: "Power",
  air_handling: "Air handling",
  water: "Water",
};

/** The system a saved piece of equipment of this kind goes into, when the
 *  building has none yet. */
export const SYSTEM_NAME: Record<Kind, string> = {
  chw_plant: "Chilled-water plant",
  power: "Power chain",
  air_handling: "Air handling",
  water: "Water",
};

export interface SuggestedSlot {
  slot: string;
  point_tag: string;
  value: number | null;
  at: string | null;
  alternatives: number;
  warning: string | null;
}

export interface SuggestedDevice {
  device_tag: string;
  points: number;
  last_seen_at: string | null;
  quiet: boolean;
  fragment: boolean;
  equipment_class: string | null;
  system_kind: Kind | null;
  why: string;
  slots: SuggestedSlot[];
  warnings: string[];
  registered: { equipment_tag: string; equipment_id: string } | null;
  feeder: { suggested: string | null; candidates: string[]; reason: string } | null;
}

export interface Suggestions {
  devices: SuggestedDevice[];
  totals: {
    devices: number;
    machines: number;
    unknown: number;
    fragments: number;
    registered: number;
    unplaced_elsewhere?: number;
  };
}

export interface Node {
  /** `eq:<equipment_id>` for a saved one, `dev:<device_tag>` for a proposal. */
  id: string;
  saved: boolean;
  label: string;
  cls: string | null;
  kind: Kind;
  /** The one reading that says most about this kind of machine. */
  headline: string | null;
  /** Anything the checks flagged. */
  warn: boolean;
  quiet: boolean;
  /** Its feeder's node id, when there is one on the drawing. */
  parent: string | null;
  device: SuggestedDevice | null;
  equipment: BiPlantEquipment | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const fmt = (v: number, digits = 1) =>
  v.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : digits });

/** The headline, from a map of slot → value. Never invented: a slot with no
 *  value leaves the headline out rather than printing a zero. */
export function headlineOf(cls: string | null, values: Record<string, number | null>): string | null {
  const v = (s: string) => values[s] ?? null;
  if (cls === "chiller") {
    const inn = v("chwr");
    const out = v("chws");
    return inn != null && out != null ? `${fmt(inn - out)} °C ΔT` : null;
  }
  if (cls === "flow_meter") {
    const r = v("flow_rate");
    return r != null ? `${fmt(r)} flow` : null;
  }
  if (cls === "ups") {
    const kw = v("kw");
    const b = v("battery");
    if (kw == null && b == null) return null;
    return [kw != null ? `${fmt(kw)} kW` : null, b != null ? `${fmt(b, 0)}% battery` : null]
      .filter(Boolean)
      .join(" · ");
  }
  const kw = v("kw");
  return kw != null ? `${fmt(kw)} kW` : null;
}

function kindOfClass(cls: string, classKinds: Record<string, string[]>): Kind | null {
  const k = classKinds[cls]?.[0];
  return (KINDS as string[]).includes(k ?? "") ? (k as Kind) : null;
}

/** Everything on the drawing, by kind. */
export function buildDrawing(
  plant: BiPlant | undefined,
  suggestions: Suggestions | undefined,
  classKinds: Record<string, string[]>,
): Record<Kind, Node[]> {
  const out: Record<Kind, Node[]> = { chw_plant: [], power: [], air_handling: [], water: [] };
  const savedByDevice = new Map<string, string>(); // device_tag -> node id

  const equipment: BiPlantEquipment[] = [
    ...(plant?.systems ?? []).flatMap((s) => s.equipment),
    ...(plant?.unassigned_equipment ?? []),
  ];
  for (const e of equipment) {
    const kind = kindOfClass(e.equipment_class, classKinds);
    if (!kind) continue;
    const values: Record<string, number | null> = {};
    for (const s of e.slots) {
      values[s.slot] = num(s.latest?.value);
      if (s.binding?.device_tag) savedByDevice.set(s.binding.device_tag, `eq:${e.equipment_id}`);
    }
    out[kind].push({
      id: `eq:${e.equipment_id}`,
      saved: true,
      label: e.tag,
      cls: e.equipment_class,
      kind,
      headline: headlineOf(e.equipment_class, values),
      warn: false,
      quiet: false,
      parent: e.fed_by_id ? `eq:${e.fed_by_id}` : null,
      device: null,
      equipment: e,
    });
  }

  for (const d of suggestions?.devices ?? []) {
    if (d.fragment || !d.equipment_class || !d.system_kind) continue;
    // Saved already: drawn from the plant, where its values are the live ones.
    if (d.registered || savedByDevice.has(d.device_tag)) continue;
    const values = Object.fromEntries(d.slots.map((s) => [s.slot, num(s.value)]));
    const feeder = d.feeder?.suggested ?? null;
    out[d.system_kind].push({
      id: `dev:${d.device_tag}`,
      saved: false,
      label: d.device_tag,
      cls: d.equipment_class,
      kind: d.system_kind,
      headline: headlineOf(d.equipment_class, values),
      warn: d.warnings.length > 0 || d.slots.some((s) => s.warning),
      quiet: d.quiet,
      parent: feeder ? savedByDevice.get(feeder) ?? `dev:${feeder}` : null,
      device: d,
      equipment: null,
    });
  }

  // A parent that is not on the drawing is not a parent the drawing can show.
  for (const k of KINDS) {
    const ids = new Set(out[k].map((n) => n.id));
    for (const n of out[k]) if (n.parent && !ids.has(n.parent)) n.parent = null;
  }
  return out;
}

export interface Tree {
  node: Node;
  children: Tree[];
}

/** The power chain as a forest, plus the meters not hung under anything. A
 *  root is TOP of the chain only when something hangs under it or it is the
 *  main incomer; otherwise it waits in `loose`. */
export function chainOf(nodes: Node[]): { roots: Tree[]; loose: Node[] } {
  const kids = new Map<string, Node[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const build = (n: Node, seen: Set<string>): Tree => ({
    node: n,
    children: (kids.get(n.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((c) => build(c, new Set([...seen, c.id]))),
  });
  const roots: Tree[] = [];
  const loose: Node[] = [];
  for (const n of nodes.filter((x) => !x.parent).sort((a, b) => a.label.localeCompare(b.label))) {
    if (kids.has(n.id) || /main/i.test(n.label)) roots.push(build(n, new Set([n.id])));
    else loose.push(n);
  }
  return { roots, loose };
}

/** Saved / total, per kind — the numbers on the tabs. */
export function countsOf(drawing: Record<Kind, Node[]>): Record<Kind, { saved: number; total: number }> {
  const c = {} as Record<Kind, { saved: number; total: number }>;
  for (const k of KINDS) {
    c[k] = { saved: drawing[k].filter((n) => n.saved).length, total: drawing[k].length };
  }
  return c;
}
