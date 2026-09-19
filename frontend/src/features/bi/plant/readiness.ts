// L3 PLANT — the model the schematic draws from. No React here.
//
// TWO THINGS ARE ON A PIECE OF EQUIPMENT AND THEY MUST NEVER BE CONFUSED.
//
//   READINESS  can the numbers be read at all: does every slot name exactly one
//              point that reported inside the window. This is the COLOUR. It is
//              the server's (`metric_registry/slots.READINESS`), five states,
//              worst first, and the schematic switches on it and nothing else.
//   HEALTH     what the numbers say: ΔT, time inside the chiller's own design
//              band, kW/TR. A metric RESULT, printed on the equipment as text,
//              and only ever a verdict when every input it reads is reporting.
//
// A chiller whose slots are not reporting is not healthy and not faulted — it
// is NOT KNOWN, and it must not be drawn as either. So nothing in this file
// derives a colour from a metric, and `metricView` refuses to print a value
// whose inputs are not all reporting even if a value came back.
import type {
  BiPlant,
  BiPlantEquipment,
  BiPlantMetricDef,
  BiPlantMetricOutcome,
  BiReadiness,
} from "@/lib/types";

/** Worst first — the server's order, used when a response does not carry it. */
export const READINESS: readonly BiReadiness[] = ["ambiguous", "unresolved", "silent", "unbound", "reporting"];

export interface ReadinessStyle {
  label: string;
  /** Stroke / text colour. Chosen apart from the pipe colours below. */
  color: string;
  /** A dash pattern, so a state never rests on hue alone. */
  dash?: string;
  /** What the state means, on hover. */
  title: string;
  /** Whether Setup → Equipment is where this state is fixed. */
  fixInDesigner: boolean;
}

export const READINESS_STYLE: Record<BiReadiness, ReadinessStyle> = {
  ambiguous: {
    label: "Ambiguous",
    color: "#f87171",
    dash: "7 2 2 2",
    title: "The binding names more than one live point — pick the meter in the designer.",
    fixInDesigner: true,
  },
  unresolved: {
    label: "Unresolved",
    color: "#fb923c",
    dash: "2 2",
    title: "The binding names a point this store does not carry — correct it in the designer.",
    fixInDesigner: true,
  },
  silent: {
    label: "Silent",
    color: "#fbbf24",
    title: "Bound to one point that produced no reading in the window. The fix is at the device or the gateway.",
    fixInDesigner: false,
  },
  unbound: {
    label: "Unbound",
    color: "#8a9bc2",
    dash: "5 4",
    title: "No point is bound to the slot — bind one in the designer.",
    fixInDesigner: true,
  },
  reporting: {
    label: "Reporting",
    color: "#34d399",
    title: "Every slot names one point that reported in the window. Says nothing about whether the machine is healthy.",
    fixInDesigner: false,
  },
};

/** A state the server grew and this build does not know. Drawn, never dropped,
 *  and never mistaken for reporting. */
const UNKNOWN_STYLE: ReadinessStyle = {
  label: "Unknown state",
  color: "#9a92c8",
  dash: "1 3",
  title: "A readiness state this console does not know.",
  fixInDesigner: false,
};

export const readinessStyle = (state: string | null | undefined): ReadinessStyle =>
  (state && READINESS_STYLE[state as BiReadiness]) || UNKNOWN_STYLE;

/** The legend's order: the server's list when it sent one. */
export const readinessOrder = (plant: BiPlant | undefined): readonly string[] =>
  plant?.readiness_states?.length ? plant.readiness_states : READINESS;

/** The pipes. Topology only — they carry no data — and deliberately in hues no
 *  readiness state uses, so a pipe is never read as a verdict. */
export const PIPE = {
  condenser: "#e879f9",
  supply: "#22d3ee",
  return: "#818cf8",
} as const;

// ── metrics ──────────────────────────────────────────────────────────────────

export type MetricView =
  | { kind: "value"; text: string; arithmetic: string | null }
  | { kind: "refused"; status: string; reason: string }
  | { kind: "unknown"; reason: string };

/** Short names for the glyph, where a line is ~20 characters. The full label is
 *  in the detail pane. Presentation only: an unknown key uses its own label. */
const SHORT: Record<string, string> = {
  chw_delta_t: "ΔT",
  chw_delta_t_in_band: "in band",
  chiller_kw_per_tr: "kW/TR",
};

export const metricShort = (def: Pick<BiPlantMetricDef, "metric" | "label">): string =>
  SHORT[def.metric] ?? def.label ?? def.metric;

export const statusWords = (status: string): string => status.replaceAll("_", " ");

function fmtValue(value: number, precision: number | null | undefined): string {
  const p = typeof precision === "number" && precision >= 0 && precision <= 6 ? precision : 2;
  return value.toFixed(p);
}

/** The metrics that apply to this equipment's class, in the server's order. */
export const metricsFor = (plant: BiPlant | undefined, eq: BiPlantEquipment): BiPlantMetricDef[] =>
  (plant?.metrics ?? []).filter((m) => m.equipment_class === eq.equipment_class);

/**
 * What one metric says about one piece of equipment.
 *
 *   refused  the evaluator refused — its reason, never a 0 and never a blank.
 *   unknown  a value came back but an input it reads is not reporting, or the
 *            value is missing. Not a verdict either way.
 *   value    every input reporting, a number, with its working.
 */
export function metricView(
  def: BiPlantMetricDef,
  outcome: BiPlantMetricOutcome | undefined,
  eq: BiPlantEquipment,
): MetricView {
  if (!outcome) {
    return {
      kind: "refused",
      status: "not_evaluated",
      reason: `${def.label ?? def.metric} was not evaluated for ${eq.tag} in this window.`,
    };
  }
  if (outcome.status !== "ok") {
    return {
      kind: "refused",
      status: outcome.status,
      reason: outcome.reason?.trim() || `refused — ${statusWords(outcome.status)}`,
    };
  }
  const reads = new Set(def.slots);
  const quiet = eq.slots.filter(
    (s) => (reads.has(s.slot) || s.required_by.includes(def.metric)) && s.readiness !== "reporting",
  );
  if (quiet.length) {
    return {
      kind: "unknown",
      reason: `not known — ${quiet.map((s) => `${s.slot} is ${s.readiness}`).join(", ")}; a metric over an input that is not reporting is not a verdict.`,
    };
  }
  if (typeof outcome.value !== "number" || !Number.isFinite(outcome.value)) {
    return { kind: "unknown", reason: "not known — the evaluator returned no number." };
  }
  const unit = outcome.unit ? ` ${outcome.unit}` : "";
  return {
    kind: "value",
    text: `${fmtValue(outcome.value, def.precision)}${unit}`,
    arithmetic: outcome.arithmetic ?? null,
  };
}

/** A refusal whose fix is a fact typed on the equipment — the ΔT band, the TR. */
export const isMissingFact = (v: MetricView): boolean => v.kind === "refused" && v.status === "missing_fact";

/** A refusal whose fix is a slot binding in the designer. */
export const isSlotRefusal = (v: MetricView): boolean =>
  v.kind === "refused" && (v.status === "slot_unbound" || v.status === "slot_unresolved" || v.status === "slot_ambiguous");

// ── presentation of the closed class vocabulary ──────────────────────────────

const CLASS_LABEL: Record<string, string> = {
  chiller: "Chiller",
  cooling_tower: "Cooling tower",
  chw_primary_pump: "Primary CHW pump",
  chw_secondary_pump: "Secondary CHW pump",
  condenser_pump: "Condenser pump",
  chw_header: "CHW header",
  ahu: "AHU",
  tfa: "TFA",
  fcu: "FCU",
  energy_meter: "Energy meter",
  dg_set: "DG set",
  pv_inverter: "PV inverter",
  water_pump: "Water pump",
};

export const classLabel = (cls: string): string => CLASS_LABEL[cls] ?? cls.replaceAll("_", " ");

const KIND_LABEL: Record<string, string> = {
  chw_plant: "Chilled-water plant loop",
  air_handling: "Air handling",
  power: "Power chain",
  water: "Water systems",
};

export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind.replaceAll("_", " ");

export const PUMP_CLASSES = new Set(["chw_primary_pump", "chw_secondary_pump", "condenser_pump", "water_pump"]);
