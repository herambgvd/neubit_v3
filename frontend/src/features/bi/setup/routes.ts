// BUILDING INTELLIGENCE → SETUP. Every piece of BI configuration, one place.
//
// neubit_v3 is sold first as a VMS; Building Intelligence is a module on top.
// So no BI configuration screen lives in Configurations: a VMS-only customer
// must never meet chillers, TR or ΔT bands. Configurations → Sites stays the
// shared list of buildings; BI reads it and writes nothing there.
//
// The tasks ARE the pipeline's gates, in the order they have to be done. This
// file is the one list of them — the checklist, the console strip and every
// link into Setup read it, so a task cannot be renamed in one place and not
// another.

export type SetupTaskId = "duplicates" | "units" | "placement" | "equipment" | "roles" | "facts";

export interface SetupTask {
  id: SetupTaskId;
  /** The pipeline gate this task opens; null for inputs no gate counts. */
  gate: number | null;
  label: string;
  /** The console strip's cell. */
  short: string;
  href: string;
  icon: string;
}

export const SETUP_HREF = "/bi/setup";

export const SETUP_TASKS: SetupTask[] = [
  { id: "duplicates", gate: 1, label: "Duplicates", short: "DUPLICATES", href: `${SETUP_HREF}/duplicates`, icon: "heroicons-outline:document-duplicate" },
  { id: "units", gate: 2, label: "Units", short: "UNITS", href: `${SETUP_HREF}/units`, icon: "heroicons-outline:tag" },
  { id: "placement", gate: 3, label: "Buildings & devices", short: "BUILDINGS", href: `${SETUP_HREF}/placement`, icon: "heroicons-outline:map-pin" },
  { id: "equipment", gate: 4, label: "Equipment", short: "EQUIPMENT", href: `${SETUP_HREF}/equipment`, icon: "heroicons-outline:cpu-chip" },
  { id: "roles", gate: 4, label: "Metric roles", short: "ROLES", href: `${SETUP_HREF}/roles`, icon: "heroicons-outline:link" },
  { id: "facts", gate: null, label: "Building facts", short: "FACTS", href: `${SETUP_HREF}/facts`, icon: "heroicons-outline:building-office-2" },
];

/** Gate 4's worklist — roles left on a point that stopped reporting. It is part
 *  of Metric roles, not a seventh task, so the strip lights ROLES on it. */
export const STRANDED_HREF = `${SETUP_HREF}/stranded`;

export const taskHref = (id: SetupTaskId): string => SETUP_TASKS.find((t) => t.id === id)!.href;

/** Which task a Setup path belongs to; null for the checklist itself. */
export function taskOfPath(pathname: string): SetupTaskId | null {
  if (pathname === STRANDED_HREF) return "roles";
  return SETUP_TASKS.find((t) => t.href === pathname)?.id ?? null;
}

/** The equipment designer, on one building, optionally on one piece of
 *  equipment. Building Intelligence sends an operator here when a chiller has no
 *  design ΔT band or no TR on file. */
export function infraDesignerHref(siteId: string, equipmentId?: string | null): string {
  const q = new URLSearchParams({ site: siteId });
  if (equipmentId) q.set("equipment", equipmentId);
  return `${taskHref("equipment")}?${q.toString()}`;
}

/** The equipment designer on one building with the I/O schedule import open —
 *  where L3 Plant's "Import I/O schedule" lands. The import itself is still
 *  gated on `bi.manage` inside the designer. */
export function infraImportHref(siteId: string): string {
  return `${taskHref("equipment")}?${new URLSearchParams({ site: siteId, import: "1" }).toString()}`;
}

/** Building facts for one building. */
export const buildingFactsHref = (siteId: string): string =>
  `${taskHref("facts")}?${new URLSearchParams({ site: siteId }).toString()}`;

/** The worklist routes that predate Setup, and where each lives now. They
 *  REDIRECT rather than render: one screen, one URL, one strip. */
export const LEGACY_SETUP_ROUTES: Record<string, string> = {
  "/bi/duplicates": taskHref("duplicates"),
  "/bi/placement": taskHref("placement"),
  "/bi/succession": STRANDED_HREF,
  "/bi/metrics": taskHref("roles"),
};

/** `dest` with the old route's query carried over — `?category=hvac` on a
 *  bookmarked placement link must still scope the list it lands on. */
export function carryQuery(
  dest: string,
  params: Record<string, string | string[] | undefined> | undefined,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  const s = q.toString();
  return s ? `${dest}?${s}` : dest;
}
