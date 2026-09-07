/**
 * The search the offline picker runs. Two things here are load-bearing and both
 * fail quietly: a coordinate parser that accepts a swapped or out-of-range pair
 * writes a plausible pin in the wrong hemisphere, and a ranking that ignores
 * population answers "delhi" with a village.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadGazetteer,
  looksNumeric,
  parseCoordinate,
  parseGazetteer,
  resetGazetteer,
  searchPlaces,
  zoomForPlace,
} from "./gazetteer";

// DELIBERATELY not in population order. The built file is written most-populous
// first, and JS sort is stable — so a fixture in that order would let a ranking
// with no population tiebreak pass. This one fails without it.
const TSV = [
  "Delhi\t\tUnited States\t42.2778\t-74.9160\t2892",
  "New Delhi\tDelhi\tIndia\t28.6214\t77.2148\t317797",
  "Pune\tMaharashtra\tIndia\t18.5196\t73.8553\t2935744",
  "Malmö\tSkåne\tSweden\t55.6058\t13.0358\t301706",
  "Delhi\tDelhi\tIndia\t28.6667\t77.2167\t10927986",
  "Mumbai\tMaharashtra\tIndia\t19.0728\t72.8826\t12691836",
].join("\n");

const byName = (name: string, country = "India") =>
  places.find((p) => p.name === name && p.country === country)!;

const places = parseGazetteer(TSV);

beforeEach(() => resetGazetteer());

describe("parseGazetteer", () => {
  it("reads every column and builds the label the result row shows", () => {
    expect(places).toHaveLength(6);
    expect(byName("Mumbai")).toMatchObject({
      name: "Mumbai",
      region: "Maharashtra",
      country: "India",
      lat: 19.0728,
      lng: 72.8826,
      population: 12691836,
      label: "Mumbai, Maharashtra, India",
    });
  });

  it("drops a row it cannot fly to instead of shipping a NaN", () => {
    expect(parseGazetteer("Nowhere\t\t\t\t\t0\n")).toHaveLength(0);
  });

  it("leaves the region out of the label when there is none", () => {
    expect(byName("Delhi", "United States").label).toBe("Delhi, United States");
  });
});

describe("parseCoordinate", () => {
  it("accepts the forms an operator actually pastes", () => {
    expect(parseCoordinate("28.6139, 77.2090")).toEqual({ lat: 28.6139, lng: 77.209 });
    expect(parseCoordinate("28.6139 77.2090")).toEqual({ lat: 28.6139, lng: 77.209 });
    expect(parseCoordinate("28.6139/77.2090")).toEqual({ lat: 28.6139, lng: 77.209 });
    expect(parseCoordinate("  -33.87, 151.21 ")).toEqual({ lat: -33.87, lng: 151.21 });
    expect(parseCoordinate("28.6139°, 77.2090°")).toEqual({ lat: 28.6139, lng: 77.209 });
  });

  it("refuses a pair that is out of range rather than guessing at it", () => {
    // Latitude and longitude swapped: both numbers are real, the point is not.
    expect(parseCoordinate("77.2090, 28.6139")).not.toBeNull(); // in range, we cannot know
    expect(parseCoordinate("100.0, 20.0")).toBeNull();
    expect(parseCoordinate("20.0, 200.0")).toBeNull();
  });

  it("is not fooled by a place name that merely contains digits", () => {
    expect(parseCoordinate("Delhi")).toBeNull();
    expect(parseCoordinate("28.6139")).toBeNull();
    expect(parseCoordinate("28.6139, 77.2090, 12")).toBeNull();
  });
});

describe("looksNumeric", () => {
  it("holds the place-list download back while a coordinate is still being typed", () => {
    expect(looksNumeric("28.6139")).toBe(true);
    expect(looksNumeric("28.6139, 77")).toBe(true);
    expect(looksNumeric("-33.87 151.21")).toBe(true);
    expect(looksNumeric("28.6139°")).toBe(true);
  });

  it("does not swallow a place name, even one with a digit in it", () => {
    expect(looksNumeric("Delhi")).toBe(false);
    expect(looksNumeric("Nizampur 2")).toBe(false);
    expect(looksNumeric("")).toBe(false);
  });
});

describe("searchPlaces", () => {
  it("says nothing until there is enough to search on", () => {
    expect(searchPlaces(places, "")).toEqual([]);
    expect(searchPlaces(places, "d")).toEqual([]);
  });

  it("puts an exact name first, then the bigger place", () => {
    const [first, second] = searchPlaces(places, "delhi");
    expect(first.label).toBe("Delhi, Delhi, India"); // exact name, 10.9M
    expect(second.label).toBe("Delhi, United States"); // exact name, 2.9k
    expect(searchPlaces(places, "delhi").map((p) => p.name)).toContain("New Delhi");
  });

  it("matches a later word, so 'delhi' still finds New Delhi", () => {
    expect(searchPlaces(places, "delhi").some((p) => p.name === "New Delhi")).toBe(true);
  });

  it("ranks a prefix above a mere word match", () => {
    expect(searchPlaces(places, "new de")[0].name).toBe("New Delhi");
  });

  it("ignores diacritics, which the operator's keyboard may not have", () => {
    expect(searchPlaces(places, "malmo")[0].name).toBe("Malmö");
    expect(searchPlaces(places, "skane")[0].name).toBe("Malmö");
  });

  it("finds a region's cities, biggest first", () => {
    const names = searchPlaces(places, "maharashtra").map((p) => p.name);
    expect(names).toEqual(["Mumbai", "Pune"]);
  });

  it("honours the limit", () => {
    expect(searchPlaces(places, "india", 2)).toHaveLength(2);
  });
});

describe("zoomForPlace", () => {
  it("pulls back for a metropolis and closes in on a town", () => {
    expect(zoomForPlace(byName("Mumbai"))).toBeLessThan(zoomForPlace(byName("New Delhi")));
  });
});

describe("loadGazetteer", () => {
  it("fetches once and shares the parse between concurrent callers", async () => {
    const fetchMock = vi.fn(async () => new Response(TSV, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([loadGazetteer(), loadGazetteer()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(await loadGazetteer()).toBe(a); // cached, still one fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure — the next keystroke must be able to retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(new Response(TSV, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadGazetteer()).rejects.toThrow(/404/);
    await expect(loadGazetteer()).resolves.toHaveLength(6);
  });
});
