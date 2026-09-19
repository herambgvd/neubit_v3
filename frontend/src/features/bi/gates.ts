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
// `unknown` state and a sentence saying so, never a zero. Gate 3 has no worklist
// in this console at all, and says that rather than offering a door.

/** Which slice of the estate a strip is answering about.
 *
 *  `domain` and `site` are the TWO SCOPES of the same console: `/bi/energy` is
 *  the domain across every building plus the points no building owns, and
 *  `/bi/energy?site=<uuid>` is that domain inside one building. They are not
 *  the same question and a strip must never answer one with the other's counts.
 *
 *  WHAT A SITE SUBJECT CAN AND CANNOT BE TOLD, because this is the whole reason
 *  the site gates read the way they do: `/bi/devices` and `/bi/points` take a
 *  `site_id`; the three WORKLIST reads — `/bi/points/ghosts`,
 *  `/bi/units/patterns`, `/bi/points/roles/orphans` — take a `category` and
 *  nothing else. So a duplicated register, an unconfirmed unit and a stranded
 *  role are facts about a DOMAIN on this deployment, not about a place. A site
 *  strip says exactly that and links to where the domain-wide answer is; it
 *  does not print the estate's figure under a building's name, and it does not
 *  print a zero it has no read for. */
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
  /** `bi.read` + the `analytics` module — every /bi worklist route. */
  bi: boolean;
  /** `sites.read` — Configurations → Sites, where placement is done. */
  sites: boolean;
}

export interface GateInput {
  subject: GateSubject;
  /** GET /bi/summary */
  summary?: any;
  /** GET /bi/points/ghosts, scoped to the subject */
  ghosts?: any;
  /** GET /bi/units/patterns, scoped to the subject */
  patterns?: any;
  /** GET /bi/points/roles/orphans — estate-wide; scoped here by category */
  orphans?: any;
  /** GET /bi/alerts — estate-wide, and gate 6 says so */
  alerts?: any;
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

/** Where the domain-wide answer lives, for the gates a site strip cannot scope.
 *  A sentence naming a blockage with nowhere to go is the dead end this console
 *  does not ship — so the site gates that defer always defer somewhere. */
const domainHref = (subject: GateSubject): string | null =>
  subject.category ? `/bi/${subject.category}` : "/bi/portfolio";

/** The two gates whose worklists are scoped by DOMAIN and by nothing else. Both
 *  read the same way at site scope, so they are written once. */
function deferredToDomain(
  input: GateInput,
  id: GateId,
  what: string,
): GateView {
  const { subject, may } = input;
  const href = domainHref(subject);
  return {
    ...gate(id),
    state: "unknown",
    quiet: "",
    count: null,
    blocking:
      `${what} is settled for ${subject.category ? "this domain" : "the estate"} as a whole, not for one building — ` +
      "the worklist behind this gate is scoped by domain and carries no site. " +
      `So this gate cannot be answered for ${subject.label}, and a figure here would be the estate's wearing a building's name.`,
    action: may.bi && href ? { href, label: "Answer it across the whole estate" } : null,
    rows: [],
  };
}

/** Rows belonging to this subject. An estate strip takes everything; a domain
 *  strip takes its own category, and a row that carries no category (a stranded
 *  role whose point row is GONE) belongs to no domain and is only ever counted
 *  at estate scope. */
function scoped<T extends { category?: string | null }>(rows: T[], subject: GateSubject): T[] {
  if (subject.kind === "estate") return rows;
  return rows.filter((r) => r.category === subject.category);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ── Gate 1 ─ ARRIVES ────────────────────────────────────────────────────────
//
// A conflux connection that is deleted and re-created mints a NEW point id for
// every point behind it, so one physical register accumulates a generation per
// rebuild — all unretired, all counted in every figure above this gate.
//
// TWO FIGURES, TWO SOURCES, AND THEY ARE NOT MIXED. `total_points` and
// `total_registers` come out of the SAME summary statement under the same
// retirement horizon, so their difference is a subtraction the server vouched
// for; it is only available at estate scope. The PAIR COUNT is the worklist's
// own, over a row set that deliberately ignores that horizon. Whichever is
// present is stated; neither is derived from the other.
function arrives(input: GateInput): GateView {
  const { summary, ghosts, subject, may } = input;
  const base = gate("arrives");
  const points: number | null = subjectPoints(summary, subject);
  const registers: number | null =
    subject.kind === "estate" && typeof summary?.total_registers === "number"
      ? summary.total_registers
      : null;
  const repeats = registers == null || points == null ? null : points - registers;
  const groups: any[] = scoped(ghosts?.groups ?? [], subject);

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

  // ONE BUILDING. The count is the leaderboard's own per-category figure for
  // this site, and it is stated — but whether any of those rows is a later
  // generation of a register already counted is a DOMAIN question (see
  // `deferredToDomain`), so this gate says the count and defers the verdict
  // rather than passing on a check it never made.
  if (subject.kind === "site") {
    return {
      ...deferredToDomain(input, "arrives", "Whether a register arrived once or several times"),
      blocking:
        `${points} ${subject.label} ${plural(points, "point is", "points are")} pinned at this building. ` +
        "Whether any of them is a later generation of a register already counted is a question about the DOMAIN — " +
        "the duplicate worklist is scoped by category and carries no site — so it cannot be settled from one building.",
    };
  }

  const shut = groups.length > 0 || !!repeats;
  if (!shut) {
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

  // TWO SENTENCES, TWO SOURCES, AND NEITHER IS DERIVED FROM THE OTHER. The
  // register figures come out of the summary; the pair count is the worklist's
  // own, over a row set that ignores the retirement horizon. Whichever answered
  // speaks; a worklist that failed cannot take the register line away, and a
  // summary that does not carry `total_registers` has NOT said the estate is
  // clean.
  const said: string[] = [];
  if (repeats) {
    said.push(
      `${repeats} of the ${points} rows counted here are later generations of a register already counted — ${registers} distinct registers. Every figure past this gate is inflated until they are settled.`,
    );
  }
  if (groups.length) {
    said.push(
      `${groups.length} duplicated ${plural(groups.length, "pair is", "pairs are")} waiting to be settled. Collapsing one deletes no reading and can be undone.`,
    );
  }
  return {
    ...base,
    state: "shut",
    count: groups.length || repeats,
    quiet: `${registers ?? points} points`,
    blocking: said.join(" "),
    action: may.bi ? { href: "/bi/duplicates", label: "Settle the duplicated registers" } : null,
    rows: groups.slice(0, 6).map((g: any) => ({
      key: `${g.device_tag} ${g.point_tag}`,
      title: `${g.device_tag} · ${g.point_tag}`,
      meta: `${(g.members || []).length} generations · ${
        g.mode === "auto" ? "no choice needed" : "needs your choice"
      }`,
    })),
  };
}

// ── Gate 2 ─ MEANS ──────────────────────────────────────────────────────────
//
// `points.unit` is null for every point on this deployment because the source
// payloads carry none (contract §11/§12). A trend chart survives that; a rating
// cannot — kWh/m²/yr is a statement about units.
//
// `eligible` and `unmatched` are NEVER summed. A point a catalogued convention
// claims is one decision shared with its siblings; a point no pattern reads
// (`Batt_Time_Rem`, `Point1`) is one-by-one work, and a single backlog figure
// cannot tell an operator which of the two they are looking at.
function means(input: GateInput): GateView {
  const { patterns, subject, may } = input;
  const base = gate("means");
  if (subject.kind === "site") {
    return deferredToDomain(input, "means", "What a point measures");
  }
  const totals = patterns?.totals;
  if (!totals) {
    return {
      ...base,
      state: "unknown",
      quiet: "",
      count: null,
      blocking: "The unit catalogue has not answered, so nothing here knows what these numbers measure.",
      action: null,
      rows: [],
    };
  }
  const unconfirmed = Math.max(0, (totals.points ?? 0) - (totals.already_confirmed ?? 0));
  if (!unconfirmed) {
    return { ...base, state: "pass", quiet: "units confirmed", count: null, blocking: "", action: null, rows: [] };
  }
  return {
    ...base,
    state: "shut",
    count: unconfirmed,
    quiet: "units confirmed",
    blocking:
      `${unconfirmed} of ${totals.points} points carry no confirmed unit, so nothing above this gate can say what they measure. ` +
      `${totals.eligible} match a catalogued tag convention and can be confirmed together once a dry run has shown the rows; ` +
      `${totals.unmatched} match none and stay one-by-one work.`,
    action: may.bi ? { href: "/bi/ratings", label: "Confirm units in Ratings" } : null,
    rows: (patterns.patterns || [])
      .filter((p: any) => p.kind === "unit" && p.eligible > 0)
      .slice(0, 6)
      .map((p: any) => ({
        key: p.key,
        title: p.label,
        meta: `${p.eligible} points waiting · proposes ${p.unit === "" ? "dimensionless" : p.unit}`,
      })),
  };
}

// ── Gate 3 ─ BELONGS ────────────────────────────────────────────────────────
//
// THIS GATE HAS NO WORKLIST IN BUILDING INTELLIGENCE AND MUST NOT GROW ONE. A
// device is placed once, on the Sites floor plan, which pins it at {x, y,
// rotation} and reaches this store over the sites event spine. A second placing
// surface here would be a second answer to one question.
//
// So the gate names its blockage and points at the console that owns the fact.
// That link is not a worklist and is not pretending to be one: it is the only
// honest action a count of unplaced points can ship with, and a gate that named
// a problem with nowhere to go would be the dead end this console does not ship.
// Without `sites.read` there is no link, only the sentence.
//
// The figure is the UNPLACED PSEUDO-ROW of the leaderboard — points no site
// owns — because that is the row that exists at both scopes: the estate takes
// its point count, a domain takes its own category's share of it.
function belongs(input: GateInput): GateView {
  const { summary, subject, may } = input;
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
  return {
    ...base,
    state: "shut",
    count: unplaced,
    quiet: "all placed",
    blocking:
      `${unplaced} of ${points} points belong to no site, so nothing above this gate can answer a question about a place. ` +
      "Building Intelligence has no placement worklist and will not grow one — a device is pinned once, on the Sites floor plan, and reaches this store from there.",
    action: may.sites ? { href: "/sites", label: "Pin the devices on the Sites floor plan" } : null,
    rows: [],
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
  if (subject.kind === "site") {
    return deferredToDomain(input, "binds", "Which metric role a point plays");
  }
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
    action: may.bi ? { href: "/bi/succession", label: "Re-point the stranded roles" } : null,
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
function acts(input: GateInput, upstream: GateView | null): GateView {
  const { alerts } = input;
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
  return { ...base, state: "pass", quiet: "alarms live", count: null, blocking: "", action: null, rows: [] };
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
