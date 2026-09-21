// THE SETUP CHECKLIST — how much of Building Intelligence's setup is done, in
// the order it has to be done.
//
// One row per Setup task. Each row is a STATE, a one-line COUNT and the page
// that changes it. This file is the model and nothing else — no JSX, no
// queries — so what a row says is decided once, from the reads the page hands
// in, and can be tested without rendering anything.
//
// The rows read the same endpoints the gate strip reads (gates.ts) and do the
// same arithmetic on them, so the checklist and the strip cannot disagree
// about a gate. What the checklist adds is PROGRESS: where a read can say how
// much is already done, the row says it.
//
// NOTHING HERE INVENTS A NUMBER. A read that has not answered makes the row
// `unknown` and its figure prints "—", never 0. A zero only appears when a read
// answered zero.
import type { BiSiteFactsRow, InfrastructureTree } from "@/lib/types";

import { DT_BAND } from "./equipment/vocabulary";
import { SETUP_TASKS, STRANDED_HREF, type SetupTask, type SetupTaskId } from "./routes";

/**
 * `done`    nothing left to do.
 * `partly`  some of it is done and some is left — both measured.
 * `todo`    work is left, and either none of it is done or the read cannot
 *           say how much is (the label says which).
 * `unknown` the read that would answer has not come back. Not `done`.
 */
export type ChecklistState = "done" | "partly" | "todo" | "unknown";

export interface ChecklistRow {
  task: SetupTask;
  state: ChecklistState;
  /** "done" / "partly" / "not started" / "to do" / "unknown". */
  stateLabel: string;
  /** The one-line figure. */
  count: string;
  /** The page that changes the count. */
  href: string;
  /** The longer reason, for a `title`. */
  why?: string;
  /** How much of this task is done, when BOTH numbers were read and the
   *  denominator is real. Absent where it would be invented — a settled
   *  duplicate LEAVES the worklist, so nothing can say how many there were. */
  progress?: { done: number; total: number };
  /** A fact that qualifies the state. `done` on Equipment means every slot on
   *  every registered machine is bound; it does not mean the plant is
   *  described, and a registry with no chiller in it has to say so. */
  note?: string;
}

export interface ChecklistInput {
  /** GET /bi/devices?placement=unplaced — `{ total }` */
  unplaced?: { total?: number } | null;
  /** GET /bi/devices?placement=placed — `{ total }` */
  placed?: { total?: number } | null;
  /** GET /bi/rating/sites, active rows. Undefined until it answers. */
  buildings?: BiSiteFactsRow[];
  /** GET /sites/{id}/infrastructure per building; undefined = not answered. */
  trees?: Record<string, InfrastructureTree | undefined>;
  /** GET /bi/metrics/roles — `{ counts: { confirmed } }` */
  roles?: { counts?: { confirmed?: number } } | null;
  /** GET /bi/points/roles/orphans — `{ orphans: [...] }` */
  orphans?: { orphans?: unknown[] } | null;
  /** Tariff slabs on record per building (GET /sites/{id}/tariff-slabs →
   *  `total`); undefined = not read (no `sites.read`, or not answered). */
  slabs?: Record<string, number | undefined>;
  /** Emission factors on record per building; undefined = not read. */
  factors?: Record<string, number | undefined>;
}

const task = (id: SetupTaskId) => SETUP_TASKS.find((t) => t.id === id)!;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const show = (v: number | null) => (v == null ? "—" : String(v));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const LABEL: Record<ChecklistState, string> = {
  done: "done",
  partly: "partly",
  todo: "not started",
  unknown: "unknown",
};

function row(id: SetupTaskId, state: ChecklistState, count: string, extra: Partial<ChecklistRow> = {}): ChecklistRow {
  const t = task(id);
  return { task: t, state, stateLabel: LABEL[state], count, href: t.href, ...extra };
}

/** Work is left and nothing measures how much is done: say "to do", not
 *  "not started" — the second is a claim about the past this read cannot make. */
const todoUnmeasured = { stateLabel: "to do" };

// ── Gate 3 · Buildings & devices ─────────────────────────────────────────────
function placement({ unplaced, placed }: ChecklistInput): ChecklistRow {
  const left = num(unplaced?.total);
  const done = num(placed?.total);
  if (left == null) {
    return row("placement", "unknown", `${show(done)} placed · — unplaced`, {
      why: "The unplaced-device list has not answered.",
    });
  }
  if (!left) return row("placement", "done", `${show(done)} placed`, {
    progress: done == null ? undefined : { done, total: done },
  });
  const count = `${show(done)} placed · ${left} unplaced ${plural(left, "device", "devices")}`;
  if (done == null) return row("placement", "todo", count, todoUnmeasured);
  return row("placement", done ? "partly" : "todo", count, {
    progress: { done, total: done + left },
  });
}

// ── Gate 4 · Equipment ───────────────────────────────────────────────────────
// A chiller is judged against its own design ΔT band, so a chiller with no
// band on file is setup left undone, and so is a declared slot with no point.
function equipment({ buildings, trees }: ChecklistInput): ChecklistRow {
  if (!buildings) return row("equipment", "unknown", "—", { why: "The list of buildings has not answered." });
  if (!buildings.length) return row("equipment", "todo", "no building in Sites", todoUnmeasured);
  const answered = buildings.map((b) => trees?.[b.site_id]);
  if (answered.some((t) => !t)) {
    return row("equipment", "unknown", "—", { why: "Not every building's equipment registry has answered." });
  }
  const all = (answered as InfrastructureTree[]).flatMap((t) => t.systems.flatMap((s) => s.equipment));
  const chillers = all.filter((e) => e.equipment_class === "chiller");
  const noBand = chillers.filter((e) => DT_BAND.some((k) => e.design?.[k] == null)).length;
  const slots = all.flatMap((e) => e.slots);
  const bound = slots.filter((s) => s.bound).length;

  const parts = [`${chillers.length} ${plural(chillers.length, "chiller", "chillers")}`, `${all.length} equipment`];
  if (slots.length) parts.push(`${bound}/${slots.length} slots bound`);
  if (noBand) parts.push(`${noBand} without ΔT band`);
  const count = parts.join(" · ");

  // `done` here means every slot on every REGISTERED machine is bound. It is
  // not a claim that the plant has been described, and a registry holding no
  // chiller says so out loud rather than letting a green tick imply it.
  const note = all.length && !chillers.length
    ? "no chiller is registered yet, so ΔT in band and kW/TR have no machine to grade"
    : undefined;
  if (!all.length) return row("equipment", "todo", count);
  return row("equipment", noBand || bound < slots.length ? "partly" : "done", count, {
    note,
    progress: slots.length ? { done: bound, total: slots.length } : undefined,
  });
}

// ── Gate 4 · Metric roles ────────────────────────────────────────────────────
// Not every point needs a role, so "unbound" is not work left. What IS left is
// a role stranded on a point that stopped reporting — and that row's action is
// the stranded worklist, because that is the page that changes the figure.
function roles({ roles: read, orphans }: ChecklistInput): ChecklistRow {
  const bound = num(read?.counts?.confirmed);
  const stranded = orphans ? (orphans.orphans ?? []).length : null;
  const count = `${show(bound)} bound · ${show(stranded)} stranded`;
  if (stranded) {
    return row("roles", "partly", count, {
      href: STRANDED_HREF,
      progress: bound == null ? undefined : { done: bound, total: bound + stranded },
    });
  }
  if (bound == null || stranded == null) {
    return row("roles", "unknown", count, { why: "The role list or the stranded-role worklist has not answered." });
  }
  return row("roles", bound ? "done" : "todo", count);
}

// ── Building facts ───────────────────────────────────────────────────────────
// Three facts per building. A tariff is recorded as a flat rate OR as
// time-of-use slabs; an emission factor only as its own list, which is read
// per building under `sites.read`. A fact nobody could read prints "—".
type Tri = boolean | null;

function facts({ buildings, slabs, factors }: ChecklistInput): ChecklistRow {
  if (!buildings) return row("facts", "unknown", "—", { why: "The list of buildings has not answered." });
  const n = buildings.length;
  if (!n) return row("facts", "todo", "no building in Sites", todoUnmeasured);

  const perSite = buildings.map((b) => {
    const s = slabs?.[b.site_id];
    const f = factors?.[b.site_id];
    const tariff: Tri = b.energy_tariff_per_kwh != null ? true : s == null ? null : s > 0;
    const factor: Tri = f == null ? null : f > 0;
    return { area: b.gross_floor_area_sqm != null, tariff, factor };
  });

  const tally = (pick: (x: (typeof perSite)[number]) => Tri) => {
    const vals = perSite.map(pick);
    return { yes: vals.filter((v) => v === true).length, unknown: vals.filter((v) => v == null).length };
  };
  const cols = [
    { label: "area", ...tally((x) => x.area) },
    { label: "tariff", ...tally((x) => x.tariff) },
    { label: "emission factor", ...tally((x) => x.factor) },
  ];

  const cell = (c: (typeof cols)[number]) =>
    n === 1
      ? `${c.label} ${c.unknown ? "—" : c.yes ? "✓" : "✗"}`
      : `${c.label} ${c.unknown ? "—" : `${c.yes}/${n}`}`;
  const count = cols.map(cell).join(" · ");
  const why = cols.some((c) => c.unknown)
    ? "A fact shown as — could not be read: the tariff slabs and emission factors are on the site record, which needs sites.read."
    : undefined;

  const missing = cols.some((c) => c.yes + c.unknown < n);
  const anything = cols.some((c) => c.yes > 0);
  if (!missing) {
    return cols.some((c) => c.unknown) ? row("facts", "unknown", count, { why }) : row("facts", "done", count);
  }
  return row("facts", anything ? "partly" : "todo", count, { why });
}

/** Every Setup task, in pipeline order. Pure. */
export function deriveChecklist(input: ChecklistInput): ChecklistRow[] {
  return [placement(input), equipment(input), roles(input), facts(input)];
}

/** The step the screen opens — the FIRST that is not done, and nothing cleverer.
 *
 * An `unknown` row stops the walk exactly as an unfinished one does. Skipping
 * past a gate whose read failed would tell an operator the gate is fine, which
 * is the one thing a failed read cannot say — and the order is the whole point
 * of the list: a role bound on a device no building owns is work thrown away.
 *
 * `-1` when every row is done, and the screen then says so instead of opening
 * a step that has nothing left in it.
 */
export function openStep(rows: ChecklistRow[]): number {
  return rows.findIndex((r) => r.state !== "done");
}
