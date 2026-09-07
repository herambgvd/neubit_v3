// What a map pin is allowed to change in the site form's address.
//
// Pure, and separate from the modal, because the RULE is the interesting part and
// it has three cases that are easy to get wrong by hand:
//
//   • an empty field is filled
//   • a field the MAP filled last time is replaced, so moving the pin actually
//     moves the address
//   • a field the operator typed is left alone
//
// The last one is the important one. OpenStreetMap frequently knows a coarser
// name for a place than the person entering it does — "NH 48" where they wrote
// "Star Mall, Delhi-Gurugram Expressway" — so silently overwriting typed text
// would lose real information every time the pin moved.

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
  /** Labels the operator had typed and that were therefore left alone. */
  kept: string[];
  /** The map-authored values, to carry into the NEXT pick. */
  fromMap: Partial<AddressValues>;
}

export function mergePickedAddress(
  current: AddressValues,
  address: ResolvedAddress | null,
  fromMap: Partial<AddressValues>,
): MergeResult {
  const next = { ...current };
  const nextFromMap: Partial<AddressValues> = { ...fromMap };
  const filled: string[] = [];
  const kept: string[] = [];

  if (!address) return { next, filled, kept, fromMap: nextFromMap };

  for (const { key, label } of ADDRESS_FIELDS) {
    const value = (address[key] || "").trim();
    // The geocoder had nothing for this field — leave whatever is there.
    if (!value) continue;

    const existing = current[key] || "";
    const typedByHand = existing.trim() !== "" && existing !== fromMap[key];
    if (typedByHand) {
      // Only worth mentioning when it actually disagrees with the map.
      if (existing.trim() !== value) kept.push(label);
      continue;
    }
    if (existing === value) continue;

    next[key] = value;
    nextFromMap[key] = value;
    filled.push(label);
  }

  return { next, filled, kept, fromMap: nextFromMap };
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
