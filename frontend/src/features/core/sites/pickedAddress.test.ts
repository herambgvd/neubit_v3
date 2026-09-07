/**
 * The rule that decides what a map pin may overwrite.
 *
 * The first version keyed off "is this field non-empty", and got the case that
 * matters most backwards: editing a site seeds the form from the SAVED record,
 * so the stale city was treated as if the operator had just typed it and the pin
 * could never correct it. What is protected is what they edited in THIS session.
 */
import { describe, expect, it } from "vitest";

import {
  mergePickedAddress,
  pickedAddressMessage,
  type AddressField,
  type AddressValues,
} from "./pickedAddress";

const EMPTY: AddressValues = { street: "", city: "", state: "", zipCode: "", country: "" };
const untouched = new Set<AddressField>();
const touched = (...fields: AddressField[]) => new Set<AddressField>(fields);

const GURUGRAM = {
  street: "NH 48",
  city: "Gurugram",
  state: "Haryana",
  zipCode: "122001",
  country: "India",
  label: "NH 48, Gurugram, Haryana, India",
};

const NOIDA = {
  street: "Sector 62",
  city: "Noida",
  state: "Uttar Pradesh",
  zipCode: "201309",
  country: "India",
  label: "Sector 62, Noida, Uttar Pradesh, India",
};

describe("mergePickedAddress", () => {
  it("fills an empty form", () => {
    const { next, filled, kept } = mergePickedAddress(EMPTY, GURUGRAM, untouched);

    expect(next).toEqual({
      street: "NH 48",
      city: "Gurugram",
      state: "Haryana",
      zipCode: "122001",
      country: "India",
    });
    expect(filled).toEqual(["street", "city", "state", "zip code", "country"]);
    expect(kept).toEqual([]);
  });

  it("REPLACES a stale value the operator has not touched — the edit case", () => {
    // An existing site being corrected: the form was seeded "Mumbai" from the
    // record, the pin now says Gurugram. This is the report that prompted the fix.
    const seeded: AddressValues = { ...EMPTY, city: "Mumbai", country: "India" };

    const { next, filled, kept } = mergePickedAddress(seeded, GURUGRAM, untouched);

    expect(next.city).toBe("Gurugram");
    expect(filled).toContain("city");
    expect(kept).toEqual([]);
  });

  it("NEVER overwrites a line the operator typed here", () => {
    const typed: AddressValues = { ...EMPTY, street: "Star Mall, Delhi-Gurugram Expressway" };

    const { next, filled, kept } = mergePickedAddress(typed, GURUGRAM, touched("street"));

    expect(next.street).toBe("Star Mall, Delhi-Gurugram Expressway");
    expect(kept).toEqual(["street"]);
    expect(filled).not.toContain("street");
    // The rest was untouched, so it still fills.
    expect(next.city).toBe("Gurugram");
  });

  it("moves the whole address when the pin moves", () => {
    const first = mergePickedAddress(EMPTY, GURUGRAM, untouched);

    const second = mergePickedAddress(first.next, NOIDA, untouched);

    expect(second.next).toEqual({
      street: "Sector 62",
      city: "Noida",
      state: "Uttar Pradesh",
      zipCode: "201309",
      country: "India",
    });
    expect(second.kept).toEqual([]);
  });

  it("keeps protecting a field once the operator has edited it", () => {
    const first = mergePickedAddress(EMPTY, GURUGRAM, untouched);
    const edited = { ...first.next, street: "Star Mall, Gate 2" };

    const second = mergePickedAddress(edited, NOIDA, touched("street"));

    expect(second.next.street).toBe("Star Mall, Gate 2");
    expect(second.kept).toEqual(["street"]);
    expect(second.next.city).toBe("Noida");
  });

  it("leaves a field the geocoder had nothing for", () => {
    const typed: AddressValues = { ...EMPTY, zipCode: "122001" };

    const { next, kept } = mergePickedAddress(typed, { ...GURUGRAM, zipCode: "" }, touched("zipCode"));

    expect(next.zipCode).toBe("122001");
    expect(kept).not.toContain("zip code"); // nothing to disagree with
  });

  it("does not report a field whose typed value already agrees with the map", () => {
    const typed: AddressValues = { ...EMPTY, country: "India" };

    const { filled, kept } = mergePickedAddress(typed, GURUGRAM, touched("country"));

    expect(kept).not.toContain("country");
    expect(filled).not.toContain("country");
  });

  it("changes nothing when the point could not be named", () => {
    const seeded: AddressValues = { ...EMPTY, city: "Gurugram" };

    const { next, filled, kept } = mergePickedAddress(seeded, null, untouched);

    expect(next).toEqual(seeded);
    expect(filled).toEqual([]);
    expect(kept).toEqual([]);
  });
});

describe("pickedAddressMessage", () => {
  it("says what happened, and says nothing when nothing did", () => {
    expect(pickedAddressMessage({ filled: ["city"], kept: [] })).toBe("Address filled from the map");
    expect(pickedAddressMessage({ filled: ["city"], kept: ["street"] })).toMatch(
      /kept the street you typed/,
    );
    expect(pickedAddressMessage({ filled: [], kept: ["street"] })).toMatch(/left alone/);
    expect(pickedAddressMessage({ filled: [], kept: [] })).toBe("");
  });
});
