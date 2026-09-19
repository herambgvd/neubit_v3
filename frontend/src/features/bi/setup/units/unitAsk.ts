// UNITS, as a queue of questions — and the platform does the checking.
//
// WHY THIS FILE EXISTS. The screen used to be twenty-one sentence-long chips
// ("Select 64 where the tag ends in `_V` — voltage, in volts → V") mixing three
// different jobs, and not one reading on the page. An operator who has never
// seen a tag cannot say whether `_V` means volts. They CAN say whether 231.4
// looks like a volt.
//
// So the platform does the part a machine can do: it reads every point's last
// known value and checks it against the unit's PLAUSIBLE range. A kind where
// every reading fits is offered in one press; a reading that does not fit is
// held back and asked about. The platform never STORES a unit — every write is
// still a person's press on points they were shown — but it does the looking,
// which is the part of this job that used to be the work.
//
// THE RANGES ARE A SCREEN, NOT A RULE. They decide what is shown together and
// what is asked about separately; they write nothing and they are printed on
// the question ("reads like volts: 0 – 1,500 V"), so an operator who knows
// better can see exactly what was checked.

export interface UnitPoint {
  point_id: string;
  point_tag: string | null;
  device_tag: string | null;
  /** Last known reading within a month; null = nothing read lately. */
  value: number | null;
  at: string | null;
}

export interface UnitPattern {
  key: string;
  label: string;
  kind: "unit" | "state" | "ambiguous";
  /** "" is a real answer — power factor's "no unit". null proposes nothing. */
  unit: string | null;
  proposes_unit?: boolean;
  basis?: string;
  eligible: number;
  points?: UnitPoint[];
}

export interface Catalogue {
  patterns: UnitPattern[];
  totals: { points: number; eligible: number; already_confirmed: number; unmatched: number };
  unmatched_points?: UnitPoint[];
}

/** What a reading in a unit plausibly looks like on a building's plant. */
interface Range {
  lo: number;
  hi: number;
  /** The range as the question prints it. */
  says: string;
}

export const RANGES: Record<string, Range> = {
  V: { lo: 0, hi: 1500, says: "0 – 1,500 V" },
  A: { lo: 0, hi: 5000, says: "0 – 5,000 A" },
  kW: { lo: -20000, hi: 20000, says: "−20,000 – 20,000 kW" },
  kVA: { lo: 0, hi: 20000, says: "0 – 20,000 kVA" },
  kWh: { lo: 0, hi: Number.POSITIVE_INFINITY, says: "never negative" },
  kVAh: { lo: 0, hi: Number.POSITIVE_INFINITY, says: "never negative" },
  Hz: { lo: 45, hi: 65, says: "45 – 65 Hz" },
  degC: { lo: -30, hi: 120, says: "−30 – 120 °C" },
  percent: { lo: 0, hi: 120, says: "0 – 120 %" },
  h: { lo: 0, hi: Number.POSITIVE_INFINITY, says: "never negative" },
  // Power factor's empty unit.
  "": { lo: -1, hi: 1, says: "−1 – 1" },
};

/** How a unit is said to an operator. */
export const UNIT_WORDS: Record<string, string> = {
  V: "volts",
  A: "amps",
  kW: "kilowatts",
  kVA: "kVA",
  kWh: "kWh",
  kVAh: "kVAh",
  Hz: "hertz",
  degC: "°C",
  percent: "percent",
  h: "hours",
  m3: "cubic metres",
  "m3/h": "cubic metres per hour",
  "": "no unit",
};

export const unitWord = (u: string | null) => (u == null ? "—" : UNIT_WORDS[u] ?? u);

/** The two readings a contradiction could be, per ambiguous convention. The
 *  operator chooses; the `hint` says what each one usually reads on a plant. */
export const CANDIDATES: Record<string, { unit: string; says: string; hint: string }[]> = {
  ambiguous_current_named_in_volts: [
    { unit: "A", says: "It is current — amps", hint: "a line current reads anything from 0 to a few hundred A" },
    { unit: "V", says: "It is voltage — volts", hint: "a phase voltage reads about 230 V, a line voltage about 415 V" },
  ],
  ambiguous_voltage_named_in_amps: [
    { unit: "V", says: "It is voltage — volts", hint: "a phase voltage reads about 230 V, a line voltage about 415 V" },
    { unit: "A", says: "It is current — amps", hint: "a line current reads anything from 0 to a few hundred A" },
  ],
  ambiguous_power_named_in_amps: [
    { unit: "kW", says: "It is power — kilowatts", hint: "one phase of a building load is usually tens of kW" },
    { unit: "A", says: "It is current — amps", hint: "a line current reads anything from 0 to a few hundred A" },
  ],
  ambiguous_energy_register_spelling: [
    { unit: "kWh", says: "Active energy — kWh", hint: "what the bill is charged on" },
    { unit: "kVAh", says: "Apparent energy — kVAh", hint: "always a little above the kWh on the same meter" },
  ],
  ambiguous_flow: [
    { unit: "m3", says: "A volume — m³", hint: "a running total that only ever goes up" },
    { unit: "m3/h", says: "A rate — m³/h", hint: "rises and falls with the pumps" },
  ],
};

/** Every unit a name that matches no convention may be given, by hand. */
export const ANY_UNIT = ["V", "A", "kW", "kVA", "kWh", "kVAh", "Hz", "degC", "percent", "h", "m3", "m3/h", ""];

export type Fit = "fits" | "outside" | "unread";

/** Does this reading look like this unit? `unread` is not a failure: a point
 *  that has read nothing lately cannot be checked, and is never shown as
 *  checked. */
export function fit(value: number | null, unit: string | null): Fit {
  if (value == null || !Number.isFinite(value)) return "unread";
  const r = unit == null ? undefined : RANGES[unit];
  if (!r) return "unread";
  return value >= r.lo && value <= r.hi ? "fits" : "outside";
}

export interface Checked {
  fits: UnitPoint[];
  outside: UnitPoint[];
  unread: UnitPoint[];
}

export function check(points: UnitPoint[], unit: string | null): Checked {
  const out: Checked = { fits: [], outside: [], unread: [] };
  for (const p of points) out[fit(p.value, unit)].push(p);
  return out;
}

// ── the questions ────────────────────────────────────────────────────────────

/** Every kind whose EVERY point read like its unit. One press accepts them all —
 *  the one place this screen is a sweep, and only over what the platform
 *  actually checked. */
export interface AcceptAllQ {
  type: "accept_all";
  key: "accept_all";
  kinds: { pattern: UnitPattern; points: UnitPoint[] }[];
  total: number;
}

/** One convention: "are these 64 in volts?" */
export interface KindQ {
  type: "kind";
  key: string;
  pattern: UnitPattern;
  unit: string;
  checked: Checked;
  all: UnitPoint[];
}

/** A switch: it has no unit. */
export interface StateQ {
  type: "state";
  key: string;
  pattern: UnitPattern;
  all: UnitPoint[];
}

/** One point whose name contradicts itself, or matches nothing. */
export interface PointQ {
  type: "point";
  key: string;
  point: UnitPoint;
  /** The convention it fell under; null when no convention claims it. */
  pattern: UnitPattern | null;
  choices: { unit: string; says: string; hint?: string }[];
}

export type Question = AcceptAllQ | KindQ | StateQ | PointQ;

/** The whole walk, in the order it is asked: what the platform could check
 *  first, then the switches, then the contradictions and the unknowns one by
 *  one. `declined` holds the keys an operator chose to go through by hand. */
export function questionsOf(cat: Catalogue | undefined, declined: string[] = []): Question[] {
  if (!cat) return [];
  const pts = (p: UnitPattern) => p.points ?? [];
  const open = cat.patterns.filter((p) => p.eligible > 0 && pts(p).length > 0);

  const units = open.filter((p) => p.kind === "unit" && p.unit != null);
  const clean = units
    .map((p) => ({ pattern: p, checked: check(pts(p), p.unit) }))
    .filter((k) => k.checked.fits.length > 0 && k.checked.outside.length === 0 && k.checked.unread.length === 0);

  const out: Question[] = [];
  const offerAll = clean.length > 1 && !declined.includes("accept_all");
  if (offerAll) {
    out.push({
      type: "accept_all",
      key: "accept_all",
      kinds: clean.map((k) => ({ pattern: k.pattern, points: k.checked.fits })),
      total: clean.reduce((n, k) => n + k.checked.fits.length, 0),
    });
  }

  const inAll = new Set(offerAll ? clean.map((k) => k.pattern.key) : []);
  for (const p of units) {
    if (inAll.has(p.key)) continue;
    out.push({ type: "kind", key: `kind:${p.key}`, pattern: p, unit: p.unit as string, checked: check(pts(p), p.unit), all: pts(p) });
  }

  for (const p of open.filter((x) => x.kind === "state")) {
    out.push({ type: "state", key: `state:${p.key}`, pattern: p, all: pts(p) });
  }

  for (const p of open.filter((x) => x.kind === "ambiguous")) {
    const choices = CANDIDATES[p.key] ?? ANY_UNIT.map((u) => ({ unit: u, says: unitWord(u) }));
    for (const pt of pts(p)) {
      out.push({ type: "point", key: `point:${pt.point_id}`, point: pt, pattern: p, choices });
    }
  }

  for (const pt of cat.unmatched_points ?? []) {
    out.push({
      type: "point",
      key: `point:${pt.point_id}`,
      point: pt,
      pattern: null,
      choices: ANY_UNIT.map((u) => ({ unit: u, says: unitWord(u) })),
    });
  }
  return out;
}

/** A reading, printed so a person can judge it: grouped, trimmed, never "NaN". */
export function reading(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  return v.toLocaleString("en-GB", { maximumFractionDigits: digits });
}
