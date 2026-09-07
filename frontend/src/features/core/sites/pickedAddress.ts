// What a map pin is allowed to change in the site form's address.
//
// Pure, and separate from the modal, because the RULE is the interesting part.
//
//   a field the operator EDITED in this session is left alone;
//   everything else the geocoder can name is replaced.
//
// The first version protected any non-empty field, and got this wrong on the
// case that matters most. Editing a site seeds the form from the SAVED record —
// city "Mumbai" on a site whose pin is being corrected to Gurugram — and that
// seeded value is exactly what the operator is there to fix. Treating it as
// hand-typed meant the address stayed half-wrong and silently disagreed with the
// coordinates right below it.
//
// A value the operator actually typed still survives: OpenStreetMap routinely
// knows a coarser name than they do — "NH 48" where they wrote "Star Mall,
// Delhi-Gurugram Expressway" — so overwriting their own words would lose real
// information every time the pin moved.

import type { ResolvedAddress } from "@/lib/map/geocoder";

/** The address inputs a map pick can fill. */
export type AddressField = "street" | "city" | "state" | "zipCode" | "country";

export const ADDRESS_FIELDS: { key: AddressField; label: string }[] = [
  { key: "street", label: "street" },
  { key: "city", label: "city" },
  { key: "state", label: "state" },
  { key: "zipCode", label: "zip code" },
  { key: "country", label: "country" },
];

export type AddressValues = Record<AddressField, string>;

export interface MergeResult {
  /** The values to write back. Unchanged fields keep their current value. */
  next: AddressValues;
  /** Human labels of what was filled, for the confirmation message. */
  filled: string[];
  /** Labels the operator had edited themselves, and that were left alone. */
  kept: string[];
}

/**
 * `touched` is the set of address fields the operator edited in THIS session —
 * not the set that happens to be non-empty. See the note at the top of the file.
 */
export function mergePickedAddress(
  current: AddressValues,
  address: ResolvedAddress | null,
  touched: ReadonlySet<AddressField>,
): MergeResult {
  const next = { ...current };
  const filled: string[] = [];
  const kept: string[] = [];

  if (!address) return { next, filled, kept };

  for (const { key, label } of ADDRESS_FIELDS) {
    const value = (address[key] || "").trim();
    // The geocoder had nothing for this field — leave whatever is there.
    if (!value) continue;

    const existing = current[key] || "";
    if (touched.has(key)) {
      // Only worth mentioning when their value actually disagrees with the map.
      if (existing.trim() !== value) kept.push(label);
      continue;
    }
    if (existing === value) continue;

    next[key] = value;
    filled.push(label);
  }

  return { next, filled, kept };
}

/** The one line shown after a pick. Empty string when there is nothing to say. */
export function pickedAddressMessage({ filled, kept }: Pick<MergeResult, "filled" | "kept">): string {
  if (filled.length && kept.length) {
    return `Address filled from the map — kept the ${kept.join(" and ")} you typed`;
  }
  if (filled.length) return "Address filled from the map";
  if (kept.length) return "Coordinates set — the address you typed was left alone";
  return "";
}
