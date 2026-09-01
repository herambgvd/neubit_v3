// NUMBER FORMATTING — decimals, separators, abbreviation, prefix/suffix, unit.
//
// PORTED from the reference's `formatNumber` + `widget-number-format.tsx`
// (`NumberFormat = {prefix, suffix, decimals, thousandsSeparator, compact}`).
// The formatting itself is theirs and is fine.
//
// WHY IT MATTERS MORE HERE THAN IT DOES THERE
// -------------------------------------------
// Contract §4: **never invent a unit.** `points.unit` is NULL for every IoT point
// on this platform because the source payloads carry none, so nothing in this
// module has ever been able to label an axis — and a fabricated `kW` is worse
// than a blank.
//
// That rule bans the software from asserting a unit. It does not ban a PERSON
// from asserting one, and a person who knows the meter is in amps should be able
// to say so. This is that surface, and it is the honest path to a labelled axis:
// the widget's author states the unit, the widget records that they stated it,
// and the tile says so on its face (`unitNote` below, rendered in the footer).
// The dataset is never edited and nothing is inferred.
//
// So `unit` is deliberately NOT just a `suffix` under another name:
//
//   suffix  is decoration — "%", "×", " ok". It says nothing about what the
//           number measures and it makes no claim.
//   unit    is a CLAIM about the physical quantity. It is stored separately,
//           attributed on the tile, and travels in the diff as its own field.
//
// Keeping them apart is what lets the tile say "kW — stated by this widget's
// author" rather than silently printing a unit as though the store had supplied
// one.

/** A widget's number format. Stored under `spec.options.format`; presentation
 *  only, never seen by the backend. */
export interface NumberFormat {
  /** Fixed fraction digits, 0–6. Undefined = the adaptive formatter in `spec.ts`. */
  decimals?: number;
  /** Group thousands. Defaults to ON; `false` is the only meaningful value. */
  thousands?: boolean;
  /** Abbreviate: 1.2K, 3.4M. */
  compact?: boolean;
  prefix?: string;
  suffix?: string;
  /** The unit the AUTHOR asserts this number is in. See the module note. */
  unit?: string;
}

/** Longest a stated unit may be. A unit is a unit, not a sentence — and this is
 *  also what stops the field being used to smuggle a caption onto every value. */
export const MAX_UNIT = 12;

const COMPACT_STEPS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** Is this format doing anything at all? An untouched format persists nothing. */
export function formatIsEmpty(f?: NumberFormat | null): boolean {
  if (!f) return true;
  return (
    f.decimals === undefined &&
    f.thousands === undefined &&
    !f.compact &&
    !f.prefix &&
    !f.suffix &&
    !f.unit
  );
}

/** Strip the keys that mean nothing, so an untouched section stores `{}` rather
 *  than a widget full of `undefined`s that show up in every version diff. */
export function tidyFormat(f: NumberFormat): NumberFormat {
  const out: NumberFormat = {};
  if (typeof f.decimals === "number" && Number.isFinite(f.decimals)) {
    out.decimals = Math.max(0, Math.min(6, Math.trunc(f.decimals)));
  }
  if (f.thousands === false) out.thousands = false;
  if (f.compact) out.compact = true;
  if (f.prefix) out.prefix = f.prefix.slice(0, 8);
  if (f.suffix) out.suffix = f.suffix.slice(0, 8);
  if (f.unit && f.unit.trim()) out.unit = f.unit.trim().slice(0, MAX_UNIT);
  return out;
}

/** One number, formatted.
 *
 *  ABSENCE STAYS ABSENCE. `null`, `undefined` and a non-finite number render as
 *  an em dash and take NO prefix, suffix or unit — "—" is the honest rendering of
 *  a bucket nothing measured, and "$—" or "— kW" would dress a hole up as a
 *  reading (contract §4). */
export function formatNumber(v: number | null | undefined, f?: NumberFormat | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const fmt = f || {};
  let n = v;
  let compactSuffix = "";

  if (fmt.compact) {
    const abs = Math.abs(n);
    for (const [step, letter] of COMPACT_STEPS) {
      if (abs >= step) {
        n = n / step;
        compactSuffix = letter;
        break;
      }
    }
  }

  const decimals = fmt.decimals;
  const grouping = fmt.thousands !== false;

  let body: string;
  if (typeof decimals === "number") {
    body = n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    });
  } else if (compactSuffix) {
    // Abbreviated and unconstrained: one decimal reads as "1.2K", which is the
    // point of abbreviating.
    body = n.toLocaleString(undefined, { maximumFractionDigits: 1, useGrouping: grouping });
  } else if (Number.isInteger(n)) {
    // An exact integer prints as one. Without this a sample COUNT of 12 renders
    // as "12.0", which reads as a measurement rather than a tally.
    body = n.toLocaleString(undefined, { useGrouping: grouping });
  } else {
    const abs = Math.abs(n);
    const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
    body = n.toLocaleString(undefined, { maximumFractionDigits: digits, useGrouping: grouping });
  }

  const tail = [compactSuffix, fmt.suffix || "", fmt.unit ? ` ${fmt.unit}` : ""].join("");
  return `${fmt.prefix || ""}${body}${tail}`;
}

/** A formatter bound to a widget's options, for the chart renderers.
 *
 *  Every chart takes one of these rather than reaching into `options` itself, so
 *  a tooltip, an axis label and a KPI tile cannot end up spelling the same number
 *  three different ways. */
export function formatterFor(options?: { format?: NumberFormat; decimals?: number } | null) {
  const fmt: NumberFormat = {
    // `options.decimals` is the older, narrower field some saved widgets carry.
    // It is read as the format's `decimals` so those widgets keep their spelling
    // rather than silently reverting to automatic.
    ...(typeof options?.decimals === "number" ? { decimals: options.decimals } : {}),
    ...(options?.format || {}),
  };
  return (v: number | null | undefined) => formatNumber(v, fmt);
}

/** The line a widget prints when its author has ASSERTED a unit.
 *
 *  Contract §4 forbids the software inventing a unit; it does not forbid a person
 *  stating one. What it does require is that the difference stays visible — so a
 *  stated unit is attributed, every time it is shown, and a viewer can tell a
 *  claim from a measurement. */
export function unitNote(options?: { format?: NumberFormat } | null): string | null {
  const unit = options?.format?.unit;
  if (!unit) return null;
  return `“${unit}” is stated by this widget's author — the dataset carries no unit`;
}
