// THE SIX GATES — the one model of Building Intelligence's pipeline.
//
// Every number this console prints has to get through six gates before it can be
// acted on, and they are ordered because each one depends on the one before it:
//
//   1 ARRIVES   the reading reached the store, once, under one identity
//   2 MEANS     somebody has said what quantity the number IS
//   3 BELONGS   the point is anchored to a place in the building
//   4 BINDS     an operator has said which metric role it plays
//   5 RATES     a rating can be computed from all of the above
//   6 ACTS      a number that is wrong can raise work
//
// This file holds the MODEL and nothing else — no JSX, no queries. It turns the
// reads the console already makes (`/bi/summary`, the ghost worklist, the unit
// pattern catalogue, the stranded-role worklist, the alert feed) into six
// statements about a SUBJECT, and the subject is either the whole estate or one
// domain of it. The same function answers at every layer; only the scope moves.
//
// WHY A MODEL AND NOT SIX PIECES OF MARKUP. Three screens each stated a gate's
// facts in their own words — Portfolio annotated its point count with the
// duplicate story, the units panel counted its own backlog, the succession
// console counted its own orphans — and none of them said which gate it was or
// what was upstream of it. Three wordings of one fact are three facts that can
// disagree. So the wording is computed once, here, and the strip renders it.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a gate that is open says almost nothing.
// Every `quiet` below is a handful of words, because a console that is
// permanently in diagnostic mode reads as a broken product rather than an honest
// one. The long sentence — `blocking` — is only ever produced for a gate that is
// actually shut, waiting on one that is, or unable to answer.
//
// NOTHING HERE INVENTS A NUMBER. A figure the reads did not supply produces the
// `unknown` state and a sentence saying so, never a zero. Gate 3's worklist is
// the unplaced devices, assigned to a building by an operator in Setup.
//
// GATES 1–4 OPEN IN SETUP. Each shut gate's action lands on the Setup task that
// opens it (features/bi/setup/routes.ts) — the gates ARE Setup's checklist.

import { STRANDED_HREF, taskHref } from "./setup/routes";

/** Which slice of the estate a strip is answering about.
 *
 *  `domain` and `site` are the TWO SCOPES of the same console: `/bi/energy` is
 *  the domain across every building plus the points no building owns, and
 *  `/bi/energy?site=<uuid>` is that domain inside one building. They are not
 *  the same question and a strip must never answer one with the other's counts.
 *
 *  WHAT A SITE SUBJECT CAN AND CANNOT BE TOLD, because this is the whole reason
 *  the site gates read the way they do: `/bi/devices` and `/bi/points` take a
 *  `site_id`; the WORKLIST read that is left — `/bi/points/roles/orphans` —
 *  takes a `category` and nothing else. So a stranded role is a fact about a
 *  DOMAIN on this deployment, not about a place. A site strip says exactly
 *  that and links to where the domain-wide answer is; it does not print the
 *  estate's figure under a building's name, and it does not print a zero it
 *  has no read for. */
export interface GateSubject {
  kind: "estate" | "domain" | "site";
  /** The gateway's own category key. Domain and site subjects only. */
  category?: string;
  /** The site this subject is narrowed to. `site` subjects only. */
  siteId?: string;
  /** What to call it in a sentence — "the estate", "Energy & Metering",
   *  "Energy & Metering at Aeon Tower". */
  label: string;
}

export type GateId = "arrives" | "means" | "belongs" | "binds" | "rates" | "acts";

/**
 * `pass`    the gate is open and says so in a handful of words.
 * `shut`    something is blocking, and this gate knows what opens it.
 * `waiting` this gate cannot be judged until an EARLIER gate opens. Not a
 *           failure of its own and never rendered as one.
 * `unknown` the read that would answer has not come back, or does not carry the
 *           field. Distinct from `pass` on purpose — silence is not health.
 */
export type GateState = "pass" | "shut" | "waiting" | "unknown";

/** Where the gate is opened. Absent when nothing on this platform opens it, or
 *  when the caller may not reach the surface that does. */
export interface GateAction {
  href: string;
  label: string;
}

/** One line of the shut gate's own worklist, scoped to the subject. */
export interface GateRow {
  key: string;
  title: string;
  meta: string;
}

export interface GateView {
  id: GateId;
  /** 1..6 — the position in the pipeline, printed. */
  n: number;
  /** ARRIVES, MEANS, … — the verb the gate is named after. */
  verb: string;
  /** What the verb means, expanded. An abbreviation never appears alone. */
  label: string;
  icon: string;
  state: GateState;
  /** The phrase this gate contributes to the quiet line when every gate passes. */
  quiet: string;
  /** The figure the segment carries when the gate is shut. */
  count: number | null;
  /** What is blocking, and what opens it. Empty for a passing gate. */
  blocking: string;
  action: GateAction | null;
  /** The head of the scoped worklist — the evidence, not a summary of it. */
  rows: GateRow[];
}

/** What the caller is allowed to reach. The strip never offers a door that
 *  would 403: a gate whose action the caller cannot open still states its
 *  blockage, it just states it without a link. */
export interface GatePermits {
  /** `workflow.instance.read` or `…create` — whether this caller may be told
   *  what is already being worked on. Not a BI key: the work is the workflow
   *  service's, and BI only asks it questions. */
  work?: boolean;
  /** `bi.read` + the `analytics` module — every /bi worklist route, gate 3's
   *  included. Whether the caller may also WRITE there is the worklist's to say. */
  bi: boolean;
}

export interface GateInput {
  subject: GateSubject;
  /** GET /bi/summary */
  summary?: any;
  /** GET /bi/points/roles/orphans — estate-wide; scoped here by category */
  orphans?: any;
  /** GET /bi/devices?placement=unplaced, scoped to the subject — the head of
   *  gate 3's worklist. Rows only; the gate's COUNT stays the summary's. */
  unplaced?: any;
  /** GET /bi/alerts — estate-wide, and gate 6 says so */
  alerts?: any;
  /** Gate 6's worklist: the ACTIONABLE findings for this subject, already
   *  filtered by `findings.actionable` — a healthy metric is not one. */
  findings?: import("./findings").Finding[];
  /** `source_key` → the open incident about it, from the workflow service.
   *  `undefined` means nobody asked (no permission, or nothing to ask about). */
  openWork?: Record<string, import("@/features/workflow/types").OpenWork> | undefined;
  /** The window those findings were read over, in hours — printed, never implied. */
  findingHours?: number;
  may: GatePermits;
}

// The six, in pipeline order. Icons are all in `lib/icons/icon-bundle.json` —
// an unbundled name renders as silent empty space, so this list is checked
// against the bundle by `icons.test.tsx` like every other literal.
const SPINE: { id: GateId; n: number; verb: string; label: string; icon: string }[] = [
  { id: "arrives", n: 1, verb: "ARRIVES", label: "reached the store once, under one identity", icon: "heroicons:arrow-down-on-square" },
  { id: "means", n: 2, verb: "MEANS", label: "somebody has said what quantity it is", icon: "heroicons:tag" },
  { id: "belongs", n: 3, verb: "BELONGS", label: "anchored to a place in the building", icon: "heroicons:map-pin" },
  { id: "binds", n: 4, verb: "BINDS", label: "bound to the metric role it plays", icon: "heroicons:variable" },
  { id: "rates", n: 5, verb: "RATES", label: "a rating can be computed from it", icon: "heroicons:star" },
  { id: "acts", n: 6, verb: "ACTS", label: "a wrong number can raise work", icon: "heroicons:bolt" },
];

const gate = (id: GateId): Omit<GateView, "state" | "quiet" | "count" | "blocking" | "action" | "rows"> =>
  SPINE.find((g) => g.id === id)!;

/** The subject's own category row out of the summary, or null at estate scope. */
const categoryRow = (summary: any, subject: GateSubject) =>
  subject.kind === "domain"
    ? (summary?.categories || []).find((c: any) => c.category === subject.category) || null
    : null;

/** The subject's own LEADERBOARD row — one building out of `summary.sites`, or
 *  null at any other scope. `sites` already carries a per-category breakdown per
 *  row, which is why a site strip needs no read the console does not make. */
const siteRow = (summary: any, subject: GateSubject) =>
  subject.kind === "site"
    ? (summary?.sites || []).find((s: any) => s.site_id === subject.siteId) || null
    : null;

/** How many points the subject covers, at whichever scope it is.
 *  `null` means the read that would say has not answered — never a zero. */
/** The same walk as `subjectPoints`, for the points that carry a unit. Every
 *  scope answers from the SAME row it took its point count from, so "301 of
 *  341" is one statement about one row set rather than two reads agreeing. */
function subjectPointsWithUnit(summary: any, subject: GateSubject): number | null {
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  if (subject.kind === "site") {
    const row = siteRow(summary, subject);
    if (!row) return null;
    if (!subject.category) return n(row.points_with_unit);
    const cat = (row.categories || []).find((c: any) => c.category === subject.category);
    // A building with no row for this domain has none of it placed here — the
    // summary stated that by omission, so zero of zero is not an invention.
    return cat ? n(cat.points_with_unit) : 0;
  }
  if (subject.kind === "domain") {
    const row = categoryRow(summary, subject);
    return row ? n(row.points_with_unit) : null;
  }
  return n(summary?.total_points_with_unit);
}

function subjectPoints(summary: any, subject: GateSubject): number | null {
  if (subject.kind === "site") {
    const row = siteRow(summary, subject);
    if (!row) return null;
    if (!subject.category) return row.points ?? null;
    // A building with no row for this domain genuinely has none of it placed
    // here. That is a fact the summary stated by omission, not an invention.
    return (row.categories || []).find((c: any) => c.category === subject.category)?.points ?? 0;
  }
  if (subject.kind === "domain") {
    const row = categoryRow(summary, subject);
    return row ? row.points : null;
  }
  return summary?.total_points ?? null;
}

/** Rows belonging to this subject. An estate strip takes everything; a domain
 *  strip takes its own category, and a row that carries no category (a stranded
 *  role whose point row is GONE) belongs to no domain and is only ever counted
 *  at estate scope. */
function scoped<T extends { category?: string | null }>(rows: T[], subject: GateSubject): T[] {
  if (subject.kind === "estate") return rows;
  // A site strip's worklists were asked with `site_id`, so every row is already
  // this building's; only a domain named on top of the building narrows further.
  if (subject.kind === "site" && !subject.category) return rows;
  return rows.filter((r) => r.category === subject.category);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ── Gate 1 ─ ARRIVES ────────────────────────────────────────────────────────
//
// It used to be a WORKLIST: a gateway connection that was deleted and re-created
// minted a new point id for every point behind it, so one physical register
// accumulated a generation per rebuild and somebody here had to say which row
// was the live sensor. The gateway keeps its ids across a rebuild now, so no new
// generations appear and there is nothing here to settle.
//
// What remains is a STATEMENT: are readings arriving, and do the rows still
// describe as many registers as there are rows. `total_points` and
// `total_registers` come out of the SAME summary statement under the same
// retirement horizon, so their difference is a subtraction the server vouched
// for; it is estate-only, and a gate with no figure says so rather than passing.
function arrives(input: GateInput): GateView {
  const { summary, subject } = input;
  const base = gate("arrives");
  const points: number | null = subjectPoints(summary, subject);
  const registers: number | null =
    subject.kind === "estate" && typeof summary?.total_registers === "number"
      ? summary.total_registers
      : null;
  const repeats = registers == null || points == null ? null : points - registers;

  if (points == null) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking:
        subject.kind === "site"
          ? "The estate summary carries no row for this building, so nothing here knows what it holds."
          : "The reading store has not said how many points it holds.",
      action: null,
      rows: [],
    };
  }

  if (!repeats) {
    return {
      ...base,
      state: "pass",
      quiet: `${registers ?? points} points`,
      count: null,
      blocking: "",
      action: null,
      rows: [],
    };
  }

  // Rows that predate the gateway's identity fix. Nothing on THIS platform
  // settles them any more, so the gate states the inflation and offers no
  // action rather than linking to a screen that no longer exists.
  return {
    ...base,
    state: "shut",
    count: repeats,
    quiet: `${registers} registers`,
    blocking:
      `${repeats} of the ${points} rows counted here are later generations of a register already counted — ` +
      `${registers} distinct registers. They predate the gateway keeping its ids across a rebuild; no new ones appear, ` +
      `and every figure past this gate stays inflated by these until they are retired.`,
    action: null,
    rows: [],
  };
}

// ── Gate 2 ─ MEANS ──────────────────────────────────────────────────────────
//
// This was a worklist too — a catalogue of tag conventions and a bulk confirm,
// because `points.unit` was NULL for every point and only a person here could
// change that. The gateway carries the unit on every envelope now: a person
// describes the signal THERE, beside its live value and its address, and 301 of
// this estate's 341 units arrived that way while none were ever typed in here.
//
// So the gate states what is known and offers no action. A number with no unit
// still cannot be graded — 5.5 is a healthy ΔT or a trivial power — and the
// sentence says where the answer is given, which is not on this platform.
function means(input: GateInput): GateView {
  const { summary, subject } = input;
  const base = gate("means");
  const points: number | null = subjectPoints(summary, subject);
  const withUnit: number | null = subjectPointsWithUnit(summary, subject);

  if (points == null || withUnit == null) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking:
        "The summary has not said how many points carry a unit, so nothing here knows what these numbers measure.",
      action: null,
      rows: [],
    };
  }

  const without = Math.max(0, points - withUnit);
  if (!without) {
    return { ...base, state: "pass", quiet: "units on record", count: null, blocking: "", action: null, rows: [] };
  }
  return {
    ...base,
    state: "shut",
    count: without,
    quiet: "units on record",
    blocking:
      `${without} of ${points} points carry no unit, so nothing above this gate can say what they measure. ` +
      `A unit is recorded on the gateway, beside the point's live value — it travels here on every reading.`,
    action: null,
    rows: [],
  };
}

// ── Gate 3 ─ BELONGS ────────────────────────────────────────────────────────
//
// A point belongs to a place through its DEVICE's placement, which core owns
// (`device_placements`) and this store mirrors. A placement used to need a pin
// on a drawn floor plan, and this estate has almost none — so most points
// belonged nowhere with no way to say otherwise. Core now takes a site alone, or
// a site and a floor, through `POST /device-placements/assign`, and this gate's
// worklist is where an operator does that: Setup → Buildings & devices, the devices
// `placement=unplaced` returns, ticked one by one and assigned by name.
//
// It is still ONE fact with one owner. The worklist writes the same table the
// floor plan does; neither is a second answer.
//
// The COUNT is the UNPLACED PSEUDO-ROW of the leaderboard — points no site
// owns — because that is the row that exists at both scopes: the estate takes
// its point count, a domain takes its own category's share of it. The ROWS are
// the devices those points sit on, which is what an operator actually assigns.
function belongs(input: GateInput): GateView {
  const { summary, unplaced: devicesRead, subject, may } = input;
  const base = gate("belongs");
  const sites: any[] = summary?.sites ?? [];
  const points: number | null = subjectPoints(summary, subject);
  // ONE BUILDING — and this is the gate that makes the scope unmistakable. A
  // site-scoped console IS the placed subset: `?site=` selects on the pin, so
  // every point in view belongs to a place by construction. The estate strip
  // beside it is SHUT on the same gate with the unplaced remainder in it, and
  // that difference is the clearest signal in the console that the scope moved.
  if (subject.kind === "site") {
    if (!summary || points == null) {
      return {
        ...base,
        state: "unknown",
        quiet: "",
        count: null,
        blocking: "The estate summary carries no row for this building, so nothing here knows what is pinned at it.",
        action: null,
        rows: [],
      };
    }
    return { ...base, state: "pass", quiet: "all placed", count: null, blocking: "", action: null, rows: [] };
  }
  if (!summary || points == null) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking: "The store has not said which points are placed.",
      action: null,
      rows: [],
    };
  }
  const unplacedRow = sites.find((s: any) => s.site_id === null) || null;
  const unplaced =
    unplacedRow == null
      ? 0
      : subject.kind === "domain"
        ? (unplacedRow.categories || []).find((c: any) => c.category === subject.category)?.points ?? 0
        : unplacedRow.points ?? 0;

  if (!unplaced) {
    return { ...base, state: "pass", quiet: "all placed", count: null, blocking: "", action: null, rows: [] };
  }
  // How many DEVICES carry those points, when the worklist answered. Absent, the
  // sentence says nothing about devices rather than a zero.
  const devices: number | null = typeof devicesRead?.total === "number" ? devicesRead.total : null;
  const href =
    subject.kind === "domain" && subject.category
      ? `${taskHref("placement")}?category=${encodeURIComponent(subject.category)}`
      : taskHref("placement");
  return {
    ...base,
    state: "shut",
    count: unplaced,
    quiet: "all placed",
    blocking:
      `${unplaced} of ${points} points belong to no site, so nothing above this gate can answer a question about a place. ` +
      (devices != null ? `They sit on ${devices} ${plural(devices, "device", "devices")}. ` : "") +
      "Each is assigned to a building by an operator, by name — a floor is optional, a pin is never needed, and nothing is assigned for you.",
    action: may.bi ? { href, label: "Assign devices to a building" } : null,
    rows: ((devicesRead?.items ?? []) as any[]).slice(0, 6).map((d: any) => ({
      key: d.device_id ?? `tag:${d.device_tag}`,
      title: d.device_tag ?? "device with no tag",
      meta: `${d.points} ${plural(d.points, "point", "points")} · ${d.category ?? "unclassified"}`,
    })),
  };
}

// ── Gate 4 ─ BINDS ──────────────────────────────────────────────────────────
//
// A collapse (gate 1) settles a connection rebuilt under the SAME tags. When the
// rebuild renames the tag too, the generations are duplicates of nothing and the
// operator's role binding is simply stranded — which is the state every
// `point_roles` row on this deployment is in, and the reason metrics refuse
// `no_data` for machines that are running.
function binds(input: GateInput): GateView {
  const { orphans, subject, may } = input;
  const base = gate("binds");
  if (!orphans) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking: "The role worklist has not answered, so nothing here knows what these numbers are bound to.",
      action: null,
      rows: [],
    };
  }
  const rows: any[] = scoped(orphans.orphans ?? [], subject);
  if (!rows.length) {
    return { ...base, state: "pass", quiet: "all bound", count: null, blocking: "", action: null, rows: [] };
  }
  const withCand = rows.filter((o) => (o.candidates || []).length).length;
  return {
    ...base,
    state: "shut",
    count: rows.length,
    quiet: "all bound",
    blocking:
      `${rows.length} operator ${plural(rows.length, "assertion is", "assertions are")} stranded on a point that stopped reporting, so every metric above them refuses for equipment that is running. ` +
      `${withCand} have a credible successor on the same device, ranked with the evidence that ranked it; ${rows.length - withCand} do not.`,
    action: may.bi ? { href: STRANDED_HREF, label: "Re-point the stranded roles" } : null,
    rows: rows.slice(0, 6).map((o: any) => ({
      key: `${o.role}::${o.point_id}`,
      title: `${o.role} · ${o.device_tag ?? "device row is gone"}`,
      meta: o.point_tag
        ? `${o.point_tag} · ${(o.candidates || []).length} candidates on the same device`
        : "the point row it named no longer exists — forgetting it is the only honest action",
    })),
  };
}

// ── Gate 5 ─ RATES ──────────────────────────────────────────────────────────
//
// A rating is the first thing on this platform that needs EVERY earlier gate,
// which is why a shut one upstream leaves this `waiting` rather than `shut`:
// nothing here is broken, and printing it as a fault of its own would send an
// operator to fix a screen that is doing exactly what it should.
//
// Passing means CCEI could actually score a site. The benchmark band is still a
// published document this deployment does not hold, and that refusal lives on
// the Ratings screen where the arithmetic is — it is not restated here.
function rates(input: GateInput, upstream: GateView | null): GateView {
  const { summary, subject, may } = input;
  const base = gate("rates");
  const sites: any[] = summary?.sites ?? [];
  // ONE BUILDING — the only gate a site strip answers BETTER than the estate
  // one. CCEI is evaluated per site, so this building's own `score` /
  // `score_reason` is the exact fact, in the registry's own words, rather than
  // a count of how many sites could be scored.
  if (subject.kind === "site") {
    const row = siteRow(summary, subject);
    if (!row) {
      return {
        ...base,
        state: "unknown",
        quiet: "",
        count: null,
        blocking: "The estate summary carries no row for this building, so nothing here knows whether it can be rated.",
        action: null,
        rows: [],
      };
    }
    if (typeof row.score === "number") {
      return { ...base, state: "pass", quiet: "rated", count: null, blocking: "", action: null, rows: [] };
    }
    return {
      ...base,
      state: "shut",
      count: null,
      quiet: "rated",
      blocking:
        row.score_reason ||
        "The metric registry did not score this building and did not say why. That silence is not a zero and is not a pass.",
      action: may.bi ? { href: "/bi/ratings", label: "Open Ratings" } : null,
      rows: [],
    };
  }
  const scored = sites.filter((s: any) => typeof s.score === "number");
  if (scored.length) {
    return { ...base, state: "pass", quiet: "rated", count: null, blocking: "", action: null, rows: [] };
  }
  if (upstream) {
    return {
      ...base,
      state: "waiting",
      quiet: "rated",
      count: null,
      blocking: `Nothing is wrong at this gate. It cannot be judged until gate ${upstream.n} · ${upstream.verb} opens.`,
      action: null,
      rows: [],
    };
  }
  return {
    ...base,
    state: "shut",
    count: null,
    quiet: "rated",
    blocking:
      "Every earlier gate is open and no site can still be scored — the components the rating needs name what is missing on the row itself.",
    action: may.bi ? { href: "/bi/ratings", label: "Open Ratings" } : null,
    rows: [],
  };
}

// ── Gate 6 ─ ACTS ───────────────────────────────────────────────────────────
//
// The last gate is the only one whose fact is not about points at all: can a
// number that is wrong raise work. The evidence is the alert feed's own
// `available` flag, which says whether anything is COLLECTING alerts — not the
// same fact as "no alerts", and it must not render the same way.
//
// That flag is ESTATE-WIDE and the sentence says so, because the feed is not
// per-category and a domain strip that implied otherwise would be inventing a
// scope the API does not have.
/** Gate 6's worklist. Operational work, NOT configuration, so it is not a Setup
 *  page: Setup is where a building is described once, and this is what an
 *  operator does with what the building is saying today. */
export const workHref = (subject: GateSubject): string =>
  subject.kind === "site" && subject.siteId ? `/bi/work?site=${subject.siteId}` : "/bi/work";

function acts(input: GateInput, upstream: GateView | null): GateView {
  const { alerts, findings, openWork, findingHours, subject, may } = input;
  const base = gate("acts");
  if (alerts?.available === false) {
    return {
      ...base,
      state: "shut",
      count: null,
      quiet: "alarms live",
      blocking:
        "Nothing on this deployment is collecting alerts, so no number here can raise work. That is estate-wide — the alert feed is not per-domain.",
      action: null,
      rows: [],
    };
  }
  if (alerts?.available !== true) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking: "The alert feed has not answered, so whether a number here can raise work is unknown.",
      action: null,
      rows: [],
    };
  }

  const window = findingHours ? `the last ${findingHours} hours` : "the window";
  const open = findings ?? [];

  // NOTHING TO ACT ON is a pass, and it is not the same as "all healthy". A
  // metric that computes has no pass mark in the registry, so it is never
  // counted here; what counts is a refusal, a bound sensor gone quiet, and an
  // alert nobody has acknowledged.
  if (open.length === 0) {
    if (upstream) {
      return {
        ...base,
        state: "waiting",
        quiet: "alarms live",
        count: null,
        blocking: `Nothing is wrong at this gate. It cannot be judged until gate ${upstream.n} · ${upstream.verb} opens.`,
        action: null,
        rows: [],
      };
    }
    return {
      ...base,
      state: "pass",
      quiet: "alarms live",
      count: null,
      blocking: "",
      action: null,
      rows: [],
    };
  }

  // Somebody has to be able to say whether these are already being worked on.
  // Counting every finding as unattended because the console was not allowed to
  // ask would invent a backlog.
  if (!may.work || openWork === undefined) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking:
        `${open.length} ${plural(open.length, "finding", "findings")} in ${window} could raise work, and whether any of them already has is not known here — ` +
        "reading that needs `workflow.instance.read`, which belongs to the workflow service, not to Building Intelligence.",
      action: null,
      rows: [],
    };
  }

  const without = open.filter((f) => !openWork[f.source_key]);
  const withWork = open.length - without.length;
  if (without.length === 0) {
    return {
      ...base,
      state: "pass",
      quiet: "alarms live",
      count: null,
      blocking: "",
      action: null,
      rows: [],
    };
  }

  return {
    ...base,
    state: "shut",
    count: without.length,
    quiet: "alarms live",
    blocking:
      `${without.length} ${plural(without.length, "finding has", "findings have")} no work open about ${plural(without.length, "it", "them")}, out of ${open.length} in ${window}` +
      (withWork ? `; ${withWork} already ${plural(withWork, "has", "have")} an incident.` : ".") +
      " Raising one sends the evidence with it, and a second raise about the same finding returns the incident already open rather than a duplicate.",
    action: may.bi ? { href: workHref(subject), label: "Raise work where it is needed" } : null,
    rows: without.slice(0, 6).map((f) => ({
      key: f.source_key,
      title: f.equipment_tag ? `${f.equipment_tag} · ${f.title}` : f.title,
      meta: f.kind === "alert" ? "raised by the gateway" : f.kind === "data_fault" ? "a bound sensor is not answering" : `refused · ${f.status}`,
    })),
  };
}

/** The six gates for one subject, in pipeline order. Pure: every figure comes
 *  from the reads handed in, and a read that has not landed produces `unknown`
 *  rather than a zero. */
export function deriveGates(input: GateInput): GateView[] {
  const one = arrives(input);
  const two = means(input);
  const three = belongs(input);
  const four = binds(input);
  // The EARLIEST shut gate is what a derived gate is waiting on — the pipeline
  // has an order, and telling an operator about gate 4 while gate 1 is inflating
  // its inputs would be telling them to do work twice.
  const core = [one, two, three, four];
  const five = rates(input, core.find((g) => g.state === "shut") || null);
  const six = acts(input, [...core, five].find((g) => g.state === "shut") || null);
  return [one, two, three, four, five, six];
}

/** True when every gate is open. This is the state the strip must recede into —
 *  `unknown` is deliberately NOT health, so a read that failed keeps the strip
 *  honest instead of quiet. */
export const allOpen = (gates: GateView[]): boolean => gates.every((g) => g.state === "pass");

/** The quiet line, when every gate is open. Terse by rule: this is what a
 *  prospect reads on a healthy estate, and it must not look like a diagnosis. */
export const quietLine = (gates: GateView[]): string =>
  gates
    .map((g) => g.quiet)
    .filter(Boolean)
    .join(" · ");
