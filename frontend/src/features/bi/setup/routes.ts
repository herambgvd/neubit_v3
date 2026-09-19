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
  /** The QUESTION this gate asks, in an operator's words. A count says how
   *  much is left; this says what is being asked, which is the thing a
   *  commissioning engineer meeting the screen for the first time lacks. */
  asks: string;
  /** Why it is worth answering, and what goes wrong while it is not. Shown on
   *  the step that is open, never on all six at once. */
  explains: string;
  /** What answering it frees. Names METRICS and other tasks, never a promise
   *  about a score — a gate answered does not make a number appear if the
   *  signal behind it is missing too. */
  unlocks: string[];
  /** The press on the open step. A verb about this task, because "Open" six
   *  times tells an operator nothing about which one they are about to do. */
  cta: string;
}

export const SETUP_HREF = "/bi/setup";

export const SETUP_TASKS: SetupTask[] = [
  {
    id: "duplicates", gate: 1, label: "Duplicates", short: "DUPLICATES",
    href: `${SETUP_HREF}/duplicates`, icon: "heroicons-outline:document-duplicate",
    asks: "which row is the live sensor?",
    explains:
      "One sensor is answering to several rows: the gateway mints a new point id every time it rebuilds a connection. Until you say which row is the live one, every count above it is inflated — and a unit confirmed on a dead row is work thrown away.",
    unlocks: ["Units", "Metric roles"],
    cta: "Settle the duplicates",
  },
  {
    id: "units", gate: 2, label: "Units", short: "UNITS",
    href: `${SETUP_HREF}/units`, icon: "heroicons-outline:tag",
    asks: "is this number °C, kW or kWh?",
    explains:
      "A number with no unit cannot be graded — 5.5 is a healthy ΔT or a trivial power, and nothing here decides which from a tag. An operator confirms it, in bulk where a tag pattern makes that safe.",
    unlocks: ["every metric that reads those points"],
    cta: "Confirm the units",
  },
  {
    id: "placement", gate: 3, label: "Buildings & devices", short: "BUILDINGS",
    href: `${SETUP_HREF}/placement`, icon: "heroicons-outline:map-pin",
    asks: "which building is this device in?",
    explains:
      "A device no building owns cannot be in any building's score. Pinning it on a floor plan is optional and useful; saying which building it belongs to is neither optional nor guessable.",
    unlocks: ["every per-building score"],
    cta: "Place the devices",
  },
  {
    id: "equipment", gate: 4, label: "Equipment", short: "EQUIPMENT",
    href: `${SETUP_HREF}/equipment`, icon: "heroicons-outline:cpu-chip",
    asks: "which point is this machine's supply temperature?",
    explains:
      "A chiller is graded against its OWN design band, not a typical one. Describe the machine and its nameplate facts, then bind each slot — supply, return, kW — to the point that measures it.",
    unlocks: ["ΔT in band", "kW/TR"],
    cta: "Describe the plant",
  },
  {
    id: "roles", gate: 4, label: "Metric roles", short: "ROLES",
    href: `${SETUP_HREF}/roles`, icon: "heroicons-outline:link",
    asks: "which point is the formula's input?",
    explains:
      "A formula asks for `owt`, never for a tag. A role is an operator's statement that this point answers that name — and a gateway rebuild can strand the statement on a point that has stopped reporting.",
    unlocks: ["the formulas that name them"],
    cta: "Bind the roles",
  },
  {
    id: "facts", gate: null, label: "Building facts", short: "FACTS",
    href: `${SETUP_HREF}/facts`, icon: "heroicons-outline:building-office-2",
    asks: "floor area, tariff, grid emission factor?",
    explains:
      "Three facts per building, each recorded with its source. Without them kWh/m², a rupee figure and kgCO₂ have no denominator, and every metric built on one refuses by name.",
    unlocks: ["energy intensity", "carbon intensity"],
    cta: "Record the facts",
  },
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
