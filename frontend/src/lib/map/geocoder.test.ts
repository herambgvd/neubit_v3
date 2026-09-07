/**
 * The Photon client. The rule worth pinning is `precise`: a house or a street is
 * the point and drops the pin, while a city is a REGION whose centre is not a
 * site. Getting that backwards saves city centres as building coordinates, which
 * is exactly the failure a geocoder was rejected for before this one existed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatHit, geocode, isAbortError, probeGeocoder, resetGeocoder, toHit } from "./geocoder";

const feature = (properties: Record<string, unknown>, coordinates = [77.0263, 28.4601]) => ({
  geometry: { coordinates, type: "Point" },
  properties,
});

beforeEach(() => resetGeocoder());

describe("formatHit", () => {
  it("leads with the building's name and narrows outward behind it", () => {
    expect(
      formatHit({
        name: "Star Tower",
        street: "Sector 30",
        city: "Gurugram",
        state: "Haryana",
        country: "India",
        postcode: "122001",
      }),
    ).toEqual({
      title: "Star Tower",
      detail: "Sector 30, Gurugram, Haryana, 122001, India",
    });
  });

  it("falls back to the street line when the place has no name", () => {
    expect(formatHit({ housenumber: "12", street: "MG Road", city: "Pune" })).toEqual({
      title: "12 MG Road",
      detail: "Pune",
    });
  });

  it("never repeats a part that is already the title", () => {
    const { title, detail } = formatHit({ name: "Gurugram", city: "Gurugram", country: "India" });
    expect(title).toBe("Gurugram");
    expect(detail).toBe("India");
  });

  it("says something rather than nothing for a feature with no usable fields", () => {
    expect(formatHit({}).title).toBe("Unnamed place");
  });
});

describe("toHit", () => {
  it("drops the pin for a house and for a street", () => {
    expect(toHit(feature({ name: "Star Tower", type: "house" }))!.precise).toBe(true);
    expect(toHit(feature({ street: "MG Road", type: "street" }))!.precise).toBe(true);
  });

  it("only FLIES for a city, a district or a state — their centres are not sites", () => {
    for (const type of ["city", "district", "county", "state", "country", "other"]) {
      expect(toHit(feature({ name: "X", type }))!.precise, type).toBe(false);
    }
  });

  it("zooms in further for a house than for a city", () => {
    expect(toHit(feature({ type: "house" }))!.zoom).toBeGreaterThan(
      toHit(feature({ type: "city" }))!.zoom,
    );
  });

  it("reads lng,lat in GeoJSON order and not the other way round", () => {
    const hit = toHit(feature({ type: "house" }, [77.0263, 28.4601]))!;
    expect(hit.lat).toBe(28.4601);
    expect(hit.lng).toBe(77.0263);
  });

  it("rejects a feature with no usable position instead of yielding NaN", () => {
    expect(toHit({ geometry: { coordinates: [] }, properties: {} })).toBeNull();
    expect(toHit({ properties: {} })).toBeNull();
  });
});

describe("geocode", () => {
  it("asks Photon's own /api and passes the map's position as a bias", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ features: [feature({ type: "house" })] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hits = await geocode("star tower", { near: { lat: 28.6, lng: 77.2 }, limit: 3 });

    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/geocode/api");
    expect(url.searchParams.get("q")).toBe("star tower");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("lat")).toBe("28.6");
    expect(url.searchParams.get("lon")).toBe("77.2");
    expect(hits).toHaveLength(1);
  });

  it("skips a malformed feature rather than failing the whole search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ features: [{ properties: {} }, feature({ type: "house" })] }),
      ),
    );
    expect(await geocode("x")).toHaveLength(1);
  });

  it("raises on a non-2xx, so the caller can fall back rather than show nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    await expect(geocode("x")).rejects.toThrow(/503/);
  });
});

describe("isAbortError", () => {
  it("recognises an abort however the environment spells it", () => {
    expect(isAbortError(new DOMException("signal is aborted without reason", "AbortError"))).toBe(true);
    const plain = new Error("aborted");
    plain.name = "AbortError";
    expect(isAbortError(plain)).toBe(true);
  });

  it("does NOT swallow a real failure — that is the whole point of asking", () => {
    expect(isAbortError(new Error("geocoder: HTTP 503"))).toBe(false);
    expect(isAbortError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("probeGeocoder", () => {
  it("asks once and remembers that the service is there", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "Ok" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeGeocoder()).toBe(true);
    expect(await probeGeocoder()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT remember an absence — the index may still be unpacking", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(Response.json({ status: "Ok" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeGeocoder()).toBe(false);
    expect(await probeGeocoder()).toBe(true);
  });
});
