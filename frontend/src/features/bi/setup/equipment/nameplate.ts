// THE PLATE FACTS — the two things no sensor sends, asked one at a time.
//
// The server (`GET /bi/sites/{id}/equipment/nameplate`) says which machines are
// still missing a fact some metric reads, and for the ΔT band it also says what
// the last 30 days of readings LOOK like. So the band is never a question from
// memory: the range is offered and a person says yes.
//
// Nothing here writes. The write is core's design PUT, which REPLACES the whole
// fact set — so `designWith` is the one piece of arithmetic that matters: it
// lays the answer over the facts the machine already has, and a fact nobody
// touched goes back exactly as core holds it.
import type { InfraDesignValue } from "@/lib/types";

export interface NameplateQuestion {
  /** `band` is one answer for two facts; `capacity` and `number` are one each. */
  kind: "band" | "capacity" | "number";
  facts: string[];
  unit: string;
  label?: string;
  observed: {
    low: number;
    high: number;
    median: number;
    hours: number;
    days: number;
    /** The machine ran all over the place: this is where it USUALLY sat, not a
     *  band to confirm with one press. */
    wide: boolean;
    spread: [number, number];
  } | null;
  /** The metrics that stay refused until this is answered. */
  blocks: string[];
}

export interface NameplateAsk {
  equipment_id: string;
  tag: string;
  name: string | null;
  equipment_class: string;
  questions: NameplateQuestion[];
}

export interface Nameplate {
  site_id: string;
  days: number;
  asks: NameplateAsk[];
  totals: { machines: number; of_interest: number; asked: number; answered: number };
}

/** One question of one machine — the wizard asks exactly one of these at a time. */
export interface Step {
  equipmentId: string;
  tag: string;
  equipmentClass: string;
  question: NameplateQuestion;
}

export function stepsOf(data: Nameplate | undefined): Step[] {
  return (data?.asks ?? []).flatMap((a) =>
    a.questions.map((question) => ({
      equipmentId: a.equipment_id,
      tag: a.tag,
      equipmentClass: a.equipment_class,
      question,
    })),
  );
}

/** What a refused metric is called in words an operator uses. A key with no
 *  entry prints as itself — a made-up phrase would be worse than the key. */
const METRIC_WORDS: Record<string, string> = {
  chiller_kw_per_tr: "how much power it draws per ton of cooling",
  chw_delta_t_in_band: "whether it is cooling the water as much as it should",
};

export function blocksText(blocks: string[]): string | null {
  if (!blocks.length) return null;
  const words = blocks.map((b) => METRIC_WORDS[b] ?? b);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export interface BandAnswer {
  low: number;
  high: number;
}

/**
 * The WHOLE fact set to PUT: what core holds now, with this answer laid over it.
 *
 * `current` is read at save time, so a fact this screen never shows is still
 * sent back unchanged and cannot be cleared by answering another one.
 */
export function designWith(
  current: Record<string, InfraDesignValue | null>,
  question: NameplateQuestion,
  answer: BandAnswer | number,
): Record<string, InfraDesignValue | null> {
  const design: Record<string, InfraDesignValue | null> = { ...current };
  if (question.kind === "band") {
    const { low, high } = answer as BandAnswer;
    design[question.facts[0]] = low;
    design[question.facts[1]] = high;
    return design;
  }
  design[question.facts[0]] = answer as number;
  return design;
}

/** A number an operator typed, or null when it is not one. A capacity is never
 *  zero or negative, and a band's ends are in order — the server refuses each of
 *  these, and saying so here means a press that cannot fail is the only one
 *  offered. */
export function readNumber(raw: string): number | null {
  const v = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

export function readBand(lowRaw: string, highRaw: string): BandAnswer | { error: string } {
  const low = readNumber(lowRaw);
  const high = readNumber(highRaw);
  if (low === null || high === null) return { error: "Both ends need a number." };
  if (high <= low) return { error: "The second number has to be the bigger one." };
  return { low, high };
}
