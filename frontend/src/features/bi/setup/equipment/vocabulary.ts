// The infra designer's reading of the server's CLOSED vocabulary, and the one
// piece of arithmetic that must never go wrong: building a design PUT.
//
// Nothing here lists a kind, a class, a slot or a fact. Every picker is built
// from `GET /site-infrastructure/vocabulary`, so a word the server grows appears
// here without an edit and a word it drops cannot be offered.
import type {
  InfraDesignFactDef,
  InfraDesignValue,
  InfraEquipmentClass,
  InfraSlotDef,
  InfraSystemKind,
  InfraVocabulary,
} from "@/lib/types";

export interface VocabIndex {
  kinds: Map<string, InfraSystemKind>;
  classes: Map<string, InfraEquipmentClass>;
  slots: Map<string, InfraSlotDef>;
  facts: Map<string, InfraDesignFactDef>;
}

export function indexVocabulary(v: InfraVocabulary): VocabIndex {
  return {
    kinds: new Map(v.system_kinds.map((k) => [k.key, k])),
    classes: new Map(v.equipment_classes.map((c) => [c.key, c])),
    slots: new Map(v.slots.map((s) => [s.key, s])),
    facts: new Map(v.design_facts.map((f) => [f.key, f])),
  };
}

/** The classes that may sit in a system of `kind` — a DG set is not part of a
 *  chilled-water loop, and the server refuses one there. */
export function classesForKind(v: InfraVocabulary, kind: string): InfraEquipmentClass[] {
  return v.equipment_classes.filter((c) => c.system_kinds.includes(kind));
}

/** The slots a class may carry, in the class's own order. */
export function slotsOf(ix: VocabIndex, cls: InfraEquipmentClass | undefined): InfraSlotDef[] {
  return (cls?.slots ?? []).map((k) => ix.slots.get(k)).filter((s): s is InfraSlotDef => !!s);
}

/** The design facts a class may carry, in the class's own order. */
export function factsOf(ix: VocabIndex, cls: InfraEquipmentClass | undefined): InfraDesignFactDef[] {
  return (cls?.facts ?? []).map((k) => ix.facts.get(k)).filter((f): f is InfraDesignFactDef => !!f);
}

/** The two facts that are one statement: half a band is not a band. */
export const DT_BAND = ["design_dt_min", "design_dt_max"] as const;

/** A recorded fact for display, or null when it was never recorded. Null is
 *  never rendered as 0 — an unrecorded TR is not a zero-ton chiller. */
export function factText(value: InfraDesignValue | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** The form's text for every fact of the class, from what is recorded. */
export function draftFrom(
  design: Record<string, InfraDesignValue>,
  facts: InfraDesignFactDef[],
): Record<string, string> {
  return Object.fromEntries(facts.map((f) => [f.key, factText(design[f.key]) ?? ""]));
}

export interface DesignBuild {
  /** The WHOLE set to PUT. */
  design: Record<string, InfraDesignValue | null>;
  /** Facts that are recorded now and would be cleared by this PUT. */
  cleared: string[];
  /** One sentence per fact the form cannot send, keyed by fact. */
  errors: Record<string, string>;
}

/**
 * The design PUT REPLACES the set, so it is built from what is recorded NOW
 * (`current`, read at save time) with only the facts the operator CHANGED laid
 * over it. A fact the operator did not touch is sent exactly as the server
 * holds it — even if it changed under an open form, and even if this form does
 * not show it — so editing one fact can never clear another. Clearing is only
 * ever the operator emptying that field, and is reported in `cleared` so the
 * screen can ask before it happens.
 */
export function buildDesign(
  current: Record<string, InfraDesignValue>,
  initial: Record<string, string>,
  draft: Record<string, string>,
  facts: InfraDesignFactDef[],
): DesignBuild {
  const design: Record<string, InfraDesignValue | null> = { ...current };
  const cleared: string[] = [];
  const errors: Record<string, string> = {};

  for (const f of facts) {
    const raw = (draft[f.key] ?? "").trim();
    if (raw === (initial[f.key] ?? "").trim()) continue; // untouched: keep what is recorded
    if (raw === "") {
      if (current[f.key] !== undefined && current[f.key] !== null) cleared.push(f.key);
      design[f.key] = null;
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors[f.key] = `${f.label} must be a number`;
        continue;
      }
      design[f.key] = n;
    } else {
      design[f.key] = raw;
    }
  }

  const [lo, hi] = DT_BAND.map((k) => design[k] ?? null);
  if ((lo === null) !== (hi === null)) {
    errors[DT_BAND[0]] = "The ΔT band needs both bounds, or neither";
  } else if (typeof lo === "number" && typeof hi === "number" && !(lo < hi)) {
    errors[DT_BAND[0]] = "The lower ΔT bound must be below the upper";
  }

  return { design, cleared, errors };
}
