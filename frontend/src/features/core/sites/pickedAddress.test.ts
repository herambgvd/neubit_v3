/**
 * The rule that decides what a map pin may overwrite. Two failures matter and
 * neither announces itself: silently replacing an address the operator typed
 * (OpenStreetMap often knows a coarser name than they do), and refusing to
 * update a field the map itself filled, so moving the pin leaves a stale address
 * attached to new coordinates.
 */
import { describe, expect, it } from "vitest";

import { mergePickedAddress, pickedAddressMessage, type AddressValues } from "./pickedAddress";

const EMPTY: AddressValues = { street: "", city: "", state: "", zipCode: "", country: "" };

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
    const { next, filled, kept } = mergePickedAddress(EMPTY, GURUGRAM, {});

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

  it("NEVER overwrites a line the operator typed", () => {
    const typed: AddressValues = { ...EMPTY, street: "Star Mall, Delhi-Gurugram Expressway" };

    const { next, filled, kept } = mergePickedAddress(typed, GURUGRAM, {});

    expect(next.street).toBe("Star Mall, Delhi-Gurugram Expressway");
    expect(kept).toEqual(["street"]);
    expect(filled).not.toContain("street");
    // The rest of the form was empty, so it still gets filled.
    expect(next.city).toBe("Gurugram");
  });

  it("DOES replace what the map itself filled, so moving the pin moves the address", () => {
    const first = mergePickedAddress(EMPTY, GURUGRAM, {});

    const second = mergePickedAddress(first.next, NOIDA, first.fromMap);

    expect(second.next).toEqual({
      street: "Sector 62",
      city: "Noida",
      state: "Uttar Pradesh",
      zipCode: "201309",
      country: "India",
    });
    expect(second.kept).toEqual([]);
  });

  it("still protects a field the operator edited AFTER the map filled it", () => {
    const first = mergePickedAddress(EMPTY, GURUGRAM, {});
    const edited = { ...first.next, street: "Star Mall, Gate 2" };

    const second = mergePickedAddress(edited, NOIDA, first.fromMap);

    expect(second.next.street).toBe("Star Mall, Gate 2");
    expect(second.kept).toEqual(["street"]);
    expect(second.next.city).toBe("Noida");
  });

  it("leaves a field the geocoder had nothing for", () => {
    const typed: AddressValues = { ...EMPTY, zipCode: "122001" };

    const { next, kept } = mergePickedAddress(typed, { ...GURUGRAM, zipCode: "" }, {});

    expect(next.zipCode).toBe("122001");
    expect(kept).not.toContain("zip code"); // nothing to disagree with
  });

  it("does not report a field whose typed value already agrees with the map", () => {
    const typed: AddressValues = { ...EMPTY, country: "India" };

    const { filled, kept } = mergePickedAddress(typed, GURUGRAM, {});

    expect(kept).not.toContain("country");
    expect(filled).not.toContain("country");
  });

  it("changes nothing when the point could not be named", () => {
    const typed: AddressValues = { ...EMPTY, city: "Gurugram" };

    const { next, filled, kept } = mergePickedAddress(typed, null, {});

    expect(next).toEqual(typed);
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
