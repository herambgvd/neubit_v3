// THE BUILDING'S RECORD — its words, and the one write per fact.
//
// The server (`GET /bi/sites/{id}/facts`) says what is on file, with where it
// came from and when, and what is missing, with the figure it holds up. This
// file says all of that in an operator's words and works out exactly what each
// press SENDS — which matters, because two of the three writes REPLACE a whole
// set and a careless one would clear what this screen does not ask about.
import type { BuildingFactsUpdate, EmissionFactorIn } from "@/lib/types";

export interface Fact {
  key: "area" | "tariff" | "emission_factor" | "benchmark";
  label: string;
  value: number | string | null;
  unit: string | null;
  source: string | null;
  recorded_at: string | null;
  /** What reads it: metric keys, and `bee_star_band` for the star rating. */
  reads: string[];
  why: string;
  /** emission_factor only — every factor with its own citation. */
  factors?: { position: number; kg_co2_per_kwh: number | null; source: string | null; effective_from: string | null }[];
  /** benchmark only. */
  standard?: string | null;
  version?: string | null;
  climate_zone?: string | null;
  ac_category?: string | null;
  ac_share_percent?: number | null;
  size_category?: string | null;
  missing?: string | null;
  reason?: string | null;
  on_file?: boolean;
  zone_options?: string[];
}

export interface FactsRecord {
  site_id: string;
  site_name: string | null;
  known: boolean;
  /** What the screen does not ask about and must still send back. */
  carried: { occupancy: number | null; tariff_currency: string | null };
  on_file: Fact[];
  missing: Fact[];
  totals: { on_file: number; missing: number };
}

/** What a figure is called in words. A key with no entry prints as itself. */
const READS_WORDS: Record<string, string> = {
  carbon_intensity: "the building's carbon per square metre",
  intensity_score: "the building's energy per square metre",
  bee_star_band: "the star rating",
  chiller_kw_per_tr: "how much power a chiller draws per ton of cooling",
};

export function readsText(keys: string[]): string | null {
  if (!keys.length) return null;
  const words = [...new Set(keys.map((k) => READS_WORDS[k] ?? k))];
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The sentence under a missing fact: which figure stays off. */
export function blockedText(fact: Fact): string {
  const what = readsText(fact.reads);
  return what
    ? `Until this is recorded, ${what} stays off. Nothing else is affected.`
    : "Nothing reads this yet.";
}

/** The zone names the seeded table publishes, in words. An unknown key prints
 *  as itself rather than being dropped — the table is the authority. */
const ZONE_WORDS: Record<string, string> = {
  warm_humid: "Warm and humid",
  composite: "Composite",
  hot_dry: "Hot and dry",
  temperate: "Temperate",
  cold: "Cold",
};
export const zoneText = (key: string | null | undefined): string | null =>
  key ? ZONE_WORDS[key] ?? key : null;

/** What a recorded benchmark reads like on one line. */
export function benchmarkLine(fact: Fact): string {
  const bits = [zoneText(fact.climate_zone)];
  if (fact.ac_share_percent != null) bits.push(`${fact.ac_share_percent}% air-conditioned`);
  else if (fact.ac_category) bits.push(fact.ac_category === "gt50pct_ac" ? "mostly air-conditioned" : "part air-conditioned");
  if (fact.version) bits.push(`bands of ${fact.version}`);
  return bits.filter(Boolean).join(" · ");
}

/** A number an operator typed, or null. An area, a rate and a carbon factor are
 *  all positive; a share is a percentage. The server refuses each of these too —
 *  saying so here means the only press offered is one that can succeed. */
export function readPositive(raw: string): number | null {
  const v = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

export function readPercent(raw: string): number | null {
  const v = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/**
 * The WHOLE building-facts set to PUT. Core's write replaces it, so every field
 * goes every time: the one being changed, the other recorded one, and the
 * occupancy this screen never shows — which would otherwise be cleared by
 * editing the area.
 */
export function factsPut(
  record: FactsRecord,
  change: { area?: number | null; tariff?: number | null; currency?: string | null },
): BuildingFactsUpdate {
  const of = (key: Fact["key"]) =>
    [...record.on_file, ...record.missing].find((f) => f.key === key)?.value ?? null;
  const area = change.area !== undefined ? change.area : (of("area") as number | null);
  const tariff = change.tariff !== undefined ? change.tariff : (of("tariff") as number | null);
  return {
    gross_floor_area_sqm: area,
    energy_tariff_per_kwh: tariff,
    tariff_currency: change.currency !== undefined ? change.currency : record.carried.tariff_currency,
    occupancy: record.carried.occupancy,
  };
}

/**
 * The WHOLE emission-factor list to PUT, with one added. Same rule: the write
 * replaces the set, so the factors already on file are sent back exactly as they
 * are and the new one goes on the end.
 */
export function factorsPut(fact: Fact | undefined, added: EmissionFactorIn): EmissionFactorIn[] {
  const kept = (fact?.factors ?? [])
    .filter((f) => f.kg_co2_per_kwh != null && f.source && f.effective_from)
    .map((f) => ({
      kg_co2_per_kwh: f.kg_co2_per_kwh as number,
      source: f.source as string,
      effective_from: (f.effective_from as string).slice(0, 10),
    }));
  return [...kept, added];
}
