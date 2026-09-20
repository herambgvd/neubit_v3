// WHAT A READING MEANS — the screen's own words, and its arithmetic.
//
// The server (`GET /bi/points/roles/asks`) says which readings something
// computed needs a meaning for, device by device, with the tag's reason, the
// live value, and the metric keys that read it. This file turns those keys and
// role names into sentences an operator uses, and works out what a device's
// "yes to all" would send.
//
// Nothing here writes. The write is `POST /bi/metrics/roles/confirm`, one role
// per call with the point ids a person saw.

export interface RoleAsk {
  point_id: string;
  point_tag: string;
  answered: boolean;
  role: string;
  role_label: string;
  basis?: string;
  needed_by: string[];
  value: number | null;
  at: string | null;
  unit: string | null;
  /** Only on a question: false when no reading arrived in the window. */
  reporting?: boolean;
  /** Another reading on this device already answers this role. */
  same_role_answered?: string[];
  /** Other unanswered readings on this device claiming the same role. */
  same_role_others?: string[];
  confirmed_by?: string | null;
  confirmed_at?: string | null;
}

export interface RoleAskDevice {
  device_id: string | null;
  device_tag: string | null;
  site_id: string | null;
  site_name: string | null;
  asks: RoleAsk[];
  answered: RoleAsk[];
}

export interface RoleAsks {
  lookback_hours: number;
  roles_read: { role: string; label: string; needed_by: string[] }[];
  devices: RoleAskDevice[];
  totals: { points: number; devices: number; asks: number; answered: number };
}

/** What a role IS, in the words of the machine room. A role with no entry keeps
 *  the server's own label — an invented sentence would be worse. */
const ROLE_WORDS: Record<string, { short: string; long: string }> = {
  inlet_water_temp: {
    short: "the water going in",
    long: "the warm water arriving from the building",
  },
  outlet_water_temp: {
    short: "the water coming out",
    long: "the cooled water going back to the building",
  },
  energy_register: {
    short: "the meter's running total",
    long: "the units it has counted since the day it was installed — it only ever goes up",
  },
  energy_period_total: {
    short: "this period's units",
    long: "a total that starts again every day, month or year",
  },
  active_power: { short: "the power it is drawing right now", long: "how much it is pulling at this moment" },
  water_volume: { short: "the water meter's running total", long: "the volume counted since it was installed" },
};

export const roleShort = (a: RoleAsk): string => ROLE_WORDS[a.role]?.short ?? a.role_label.toLowerCase();
export const roleLong = (a: RoleAsk): string | null => ROLE_WORDS[a.role]?.long ?? null;

/** What a metric is called in words. A key nobody has words for prints as
 *  itself, so a metric seeded later is named, not hidden. */
const METRIC_WORDS: Record<string, string> = {
  chiller_delta_t: "how hard this chiller is working",
  chw_delta_t: "how hard this chiller is working",
  chw_delta_t_in_band: "whether it is cooling the water as much as it should",
  hvac_health: "the cooling system's health score",
  carbon_intensity: "the building's carbon per square metre",
  intensity_score: "the building's energy per square metre",
  chiller_kw_per_tr: "how much power it draws per ton of cooling",
};

export function neededByText(keys: string[]): string | null {
  if (!keys.length) return null;
  const words = [...new Set(keys.map((k) => METRIC_WORDS[k] ?? k))];
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** A question the platform would rather a person looked at twice: no reading in
 *  the window (the confirm guard will challenge it), the device already answers
 *  this role elsewhere, or several readings here claim it. */
export function cautionOf(a: RoleAsk): string | null {
  if (a.same_role_answered?.length) {
    return `${a.same_role_answered.join(", ")} on this device already answers this — saying yes here would count one sensor twice`;
  }
  if (a.reporting === false) {
    return "nothing has arrived from this reading recently — check it is the live one";
  }
  if (a.same_role_others?.length) {
    return `${a.same_role_others.join(", ")} claim the same thing — only one of them is it`;
  }
  return null;
}

/** The presses a "yes to everything here" would make: one per role, carrying
 *  the ids of the questions it covers. A question with a caution is LEFT OUT —
 *  a bulk press must never be the way a doubtful answer gets stored. */
export function bulkOf(device: RoleAskDevice): { role: string; point_ids: string[] }[] {
  const by = new Map<string, string[]>();
  for (const a of device.asks) {
    if (cautionOf(a)) continue;
    by.set(a.role, [...(by.get(a.role) ?? []), a.point_id]);
  }
  return [...by.entries()].map(([role, point_ids]) => ({ role, point_ids }));
}

export const fmtValue = (a: RoleAsk): string => {
  if (a.value == null || !Number.isFinite(a.value)) return "no reading";
  const n = a.value.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(a.value) >= 100 ? 0 : 1 });
  return a.unit ? `${n} ${a.unit}` : n;
};
