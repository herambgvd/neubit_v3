// DUPLICATES, as a queue of QUESTIONS rather than a worklist of groups.
//
// WHY THIS FILE EXISTS. The screen used to show an operator two uuids, two
// timestamps minutes apart, "gone quiet" on both, "not recorded" for the unit
// and "none bound" for the role — and then asked which one is the real sensor.
// That is not a question a person can answer from what is on the screen. The
// worklist was honest and useless at the same time.
//
// What makes it answerable is what each record CARRIES: when it started, how
// long it ran, how many readings it holds, whether a metric uses it. One record
// ran for months and holds the history; the other appeared at a rebuild. That
// is an ordinary judgement, and it is the one the endpoint now serves the facts
// for (`first_seen_at`, `readings`).
//
// NOTHING HERE RECOMMENDS AN ANSWER. It ranks and describes; the operator
// decides. A "keep the older one" rule would be a guess about a building — the
// gateway can be rebuilt because a sensor was REPLACED, and then the young
// record is the real one. The screen says what is true of each and stops.
export interface GhostMember {
  point_id: string;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  readings?: number | null;
  unit?: string | null;
  fresh?: boolean;
  has_role?: boolean;
  role?: string | null;
}

export interface GhostGroup {
  device_tag: string;
  point_tag: string;
  category?: string | null;
  mode: "auto" | "manual";
  survivor_point_id?: string | null;
  members: GhostMember[];
}

/** One record, described in the words the screen uses. */
export interface Choice {
  point_id: string;
  /** "A", "B", "C" — what the operator presses, and what the tile is titled. */
  letter: string;
  /** Days between the first and the last reading; null when either is missing. */
  days: number | null;
  readings: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Still delivering inside the freshness window. */
  live: boolean;
  /** A metric reads this record today. Losing it moves the role, never the
   *  metric — but an operator should know which one is wired up. */
  role: string | null;
  /** True for the record that holds the most history in its group. A FACT
   *  about the rows, not advice about which to keep. */
  mostHistory: boolean;
  /** True for the record that reported most recently. Also just a fact. */
  latest: boolean;
  /** Where this record sits on the group's shared time axis, in percent —
   *  `left` from the earliest first reading of ANY record in the group, `width`
   *  its own span. Null when either end is unknown: a bar drawn from a guess
   *  is a picture of nothing. Two records side by side then show at a glance
   *  which one ran for months and which one appeared at a rebuild. */
  span: { left: number; width: number } | null;
}

export interface Question {
  key: string;
  device_tag: string;
  point_tag: string;
  category: string | null;
  choices: Choice[];
  /** Why this one is being asked at all — the honest version of "manual". */
  because: "none_live" | "several_live";
}

const LETTERS = "ABCDEFGH";
const MS_DAY = 86_400_000;

const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const questionKey = (g: { device_tag: string; point_tag: string }) =>
  `${g.device_tag}\u001f${g.point_tag}`;

/** How long a record ran, in whole days. A record that started and stopped
 *  inside one day is 0 days, never null — null is reserved for "not known". */
export function daysOf(m: GhostMember): number | null {
  const a = time(m.first_seen_at);
  const b = time(m.last_seen_at);
  if (a == null || b == null || b < a) return null;
  return Math.floor((b - a) / MS_DAY);
}

/** Turn one group into the question it really is. */
export function toQuestion(g: GhostGroup): Question {
  const live = g.members.filter((m) => m.fresh).length;
  const members = g.members
    .slice()
    .sort((a, b) => (time(b.last_seen_at) ?? 0) - (time(a.last_seen_at) ?? 0));

  const spans = members.map(daysOf);
  const readings = members.map((m) => num(m.readings));
  const widest = Math.max(...spans.map((d) => d ?? -1), -1);
  const newest = Math.max(...members.map((m) => time(m.last_seen_at) ?? -1), -1);

  // The shared axis: earliest start to latest stop across the whole group.
  const starts = members.map((m) => time(m.first_seen_at)).filter((v): v is number => v != null);
  const stops = members.map((m) => time(m.last_seen_at)).filter((v): v is number => v != null);
  const axis0 = starts.length ? Math.min(...starts) : null;
  const axis1 = stops.length ? Math.max(...stops) : null;
  const barOf = (m: GhostMember): Choice["span"] => {
    const a = time(m.first_seen_at);
    const b = time(m.last_seen_at);
    if (a == null || b == null || axis0 == null || axis1 == null || b < a) return null;
    const whole = Math.max(axis1 - axis0, 1);
    const left = ((a - axis0) / whole) * 100;
    // A record that lived a few hours on a months-long axis must still be
    // visible — a zero-width bar reads as "no data", which is false.
    const width = Math.max(((b - a) / whole) * 100, 1.5);
    return { left: Math.min(left, 100 - width), width: Math.min(width, 100) };
  };

  return {
    key: questionKey(g),
    device_tag: g.device_tag,
    point_tag: g.point_tag,
    category: g.category ?? null,
    because: live === 0 ? "none_live" : "several_live",
    choices: members.map((m, i) => ({
      point_id: m.point_id,
      letter: LETTERS[i] ?? String(i + 1),
      days: spans[i],
      readings: readings[i],
      firstSeen: m.first_seen_at ?? null,
      lastSeen: m.last_seen_at ?? null,
      live: !!m.fresh,
      role: m.has_role ? (m.role ?? "a metric") : null,
      // A tie makes BOTH true rather than picking one arbitrarily: two records
      // that ran the same length are two records that ran the same length.
      mostHistory: widest >= 0 && spans[i] === widest,
      latest: newest >= 0 && time(m.last_seen_at) === newest,
      span: barOf(m),
    })),
  };
}

/** The queue: every group that needs a person, in the order it is asked.
 *
 * Groups the server already settled (`auto` — exactly one record is still
 * delivering, so the others are provably superseded) are NOT here: they are the
 * sweep's, and asking a person to confirm what the data already says is how a
 * 45-question queue becomes a 46-question one. */
export function questionsOf(groups: GhostGroup[]): Question[] {
  return groups.filter((g) => g.mode === "manual").map(toQuestion);
}

/** A reading count an operator can read at a glance. Exact under 10 000,
 *  because "9 999" is a fact and "10k" is a rounding. */
export function readingsLabel(n: number | null): string {
  if (n == null) return "not known";
  if (n < 10_000) return n.toLocaleString("en-GB");
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "252 days", "under a day", "not known". */
export function daysLabel(d: number | null): string {
  if (d == null) return "not known";
  if (d === 0) return "under a day";
  return `${d.toLocaleString("en-GB")} ${d === 1 ? "day" : "days"}`;
}
