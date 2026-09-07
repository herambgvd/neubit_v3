/**
 * The box that stops an operator dragging the world.
 *
 * Two rules are load-bearing and both fail silently. First, the geocoder is the
 * ANSWER and the city gazetteer is the FALLBACK — showing both would file
 * "Gurugram" underneath the actual building. Second, a result only drops the pin
 * when it is precise: a city centre is not a site, and saving one as a building's
 * coordinates is the exact failure a geocoder was rejected for before.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetGazetteer } from "@/lib/map/gazetteer";
import { resetGeocoder } from "@/lib/map/geocoder";

import PlaceSearch from "./PlaceSearch";

const TSV = [
  "Mumbai\tMaharashtra\tIndia\t19.0728\t72.8826\t12691836\tBombay",
  "Delhi\tDelhi\tIndia\t28.6667\t77.2167\t10927986\t",
  "New Delhi\tDelhi\tIndia\t28.6214\t77.2148\t317797\t",
  "Gurugram\tHaryana\tIndia\t28.4601\t77.0263\t886519\tGurgaon",
].join("\n");

const STAR_TOWER = {
  geometry: { coordinates: [77.0731, 28.4595], type: "Point" },
  properties: {
    name: "Star Tower",
    street: "Sector 30",
    city: "Gurugram",
    state: "Haryana",
    country: "India",
    type: "house",
  },
};

/**
 * Routes by URL rather than answering everything the same way: the component
 * talks to two different endpoints, and a single canned response would let a
 * test pass because the WRONG one replied.
 */
function stubNetwork({ geocoder = true, hits = [STAR_TOWER] as unknown[] } = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/geocode/status")) {
      if (!geocoder) throw new Error("connection refused");
      return Response.json({ status: "Ok" });
    }
    if (url.startsWith("/geocode/api")) return Response.json({ features: hits });
    if (url.startsWith("/map/gazetteer")) return new Response(TSV, { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

let onGo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetGazetteer();
  resetGeocoder();
  onGo = vi.fn();
});

const box = () => screen.getByRole("textbox", { name: /search for a place/i });

describe("PlaceSearch with the geocoder installed", () => {
  it("finds a building by its address and drops the pin on it", async () => {
    stubNetwork();
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "Star Tower Sector 30 Gurgaon");

    await userEvent.click(await screen.findByText("Star Tower"));

    expect(onGo).toHaveBeenCalledWith({ lat: 28.4595, lng: 77.0731, zoom: 17, drop: true });
  });

  it("only flies for a city result, because its centre is not a site", async () => {
    stubNetwork({
      hits: [
        {
          geometry: { coordinates: [77.0263, 28.4601], type: "Point" },
          properties: { name: "Gurugram", state: "Haryana", country: "India", type: "city" },
        },
      ],
    });
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "gurugram");

    await userEvent.click(await screen.findByText("Gurugram"));

    expect(onGo.mock.calls[0][0].drop).toBe(false);
  });

  it("shows the address INSTEAD of the city list, not alongside it", async () => {
    stubNetwork();
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "Star Tower Sector 30 Gurgaon");

    await screen.findByText("Star Tower");
    expect(screen.queryByText("Gurugram")).not.toBeInTheDocument();
  });

  it("debounces, so an address is one lookup and not a dozen", async () => {
    const mock = stubNetwork();
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "star tower");

    await screen.findByText("Star Tower");
    expect(mock.mock.calls.filter(([u]) => String(u).startsWith("/geocode/api"))).toHaveLength(1);
  });
});

describe("PlaceSearch without the geocoder", () => {
  it("falls back to the city list", async () => {
    stubNetwork({ geocoder: false });
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "new de");

    await userEvent.click(await screen.findByText("New Delhi"));

    expect(onGo).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 28.6214, lng: 77.2148, drop: false }),
    );
  });

  it("still gets a pasted street address to the right town", async () => {
    stubNetwork({ geocoder: false });
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "Star Tower Sector 30 Gurgaon");

    await userEvent.click(await screen.findByText("Gurugram"));

    expect(onGo.mock.calls[0][0].drop).toBe(false);
  });

  it("says why the answers are coarse instead of just looking broken", async () => {
    stubNetwork({ geocoder: false });
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "zzzqqq");

    expect(await screen.findByText(/Address search is not installed/i)).toBeInTheDocument();
  });
});

describe("PlaceSearch and a superseded lookup", () => {
  /**
   * There is no AbortController any more — aborting an in-flight fetch kept
   * leaking AbortErrors into the dev overlay. A generation counter drops the
   * stale answer instead, which means the ONE thing that must hold is that a
   * slow answer to an old query cannot overwrite a newer one.
   */
  it("ignores a slow answer to a query the operator has already moved past", async () => {
    const slow = {
      geometry: { coordinates: [72.8826, 19.0728], type: "Point" },
      properties: { name: "Slow Answer", city: "Mumbai", type: "house" },
    };
    // null until the FIRST lookup is genuinely in flight. The first version of
    // this test seeded it with a no-op, so `waitFor` passed instantly, the slow
    // request was never actually issued, and releasing it did nothing — the test
    // stayed green with the staleness guard deleted.
    let releaseFirst: ((value: Response) => void) | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/geocode/status")) return Response.json({ status: "Ok" });
        if (url.startsWith("/map/gazetteer")) return new Response(TSV, { status: 200 });
        if (url.includes("q=slow")) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Response.json({ features: [STAR_TOWER] });
      }),
    );

    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "slow");
    await waitFor(() => expect(releaseFirst).not.toBeNull());

    // Move on before the first answer lands, then let it land.
    await userEvent.clear(box());
    await userEvent.type(box(), "star tower");
    await screen.findByText("Star Tower");
    releaseFirst!(Response.json({ features: [slow] }));

    // The stale answer must never appear, and must not evict the current one.
    await waitFor(() => expect(screen.queryByText("Slow Answer")).not.toBeInTheDocument());
    expect(screen.getByText("Star Tower")).toBeInTheDocument();
  });

  it("says the service is down instead of looking like the address is unmapped", async () => {
    stubNetwork({ hits: [] });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/geocode/status")) return Response.json({ status: "Ok" });
      if (url.startsWith("/geocode/api")) return new Response("boom", { status: 503 });
      if (url.startsWith("/map/gazetteer")) return new Response(TSV, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<PlaceSearch onGo={onGo} />);

    await userEvent.type(box(), "star tower gurgaon");

    expect(await screen.findByText(/Address search is not answering/i)).toBeInTheDocument();
    // ...and still gets the operator somewhere, off the city list.
    expect(await screen.findByText("Gurugram")).toBeInTheDocument();
  });
});

describe("PlaceSearch, either way", () => {
  it("fetches nothing until there is a real query", async () => {
    const mock = stubNetwork();
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "m");

    const lookups = mock.mock.calls.filter(([u]) => !String(u).startsWith("/geocode/status"));
    expect(lookups).toHaveLength(0);
  });

  it("drops the pin for a pasted coordinate, and looks nothing up", async () => {
    const mock = stubNetwork();
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "28.6139, 77.2090");

    await userEvent.click(await screen.findByText(/Go to 28\.613900, 77\.209000/));

    expect(onGo).toHaveBeenCalledWith({ lat: 28.6139, lng: 77.209, zoom: 16, drop: true });
    const lookups = mock.mock.calls.filter(([u]) => !String(u).startsWith("/geocode/status"));
    expect(lookups).toHaveLength(0);
  });

  it("takes Arrow keys and Enter", async () => {
    stubNetwork({ geocoder: false });
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "delhi");
    await screen.findByText("New Delhi");

    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(onGo).toHaveBeenCalledTimes(1);
    expect(onGo.mock.calls[0][0].lat).not.toBe(28.6667);
  });

  it("clears back to nothing", async () => {
    stubNetwork({ geocoder: false });
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "delhi");
    await screen.findByText("New Delhi");

    await userEvent.click(screen.getByRole("button", { name: /clear search/i }));

    expect(box()).toHaveValue("");
    await waitFor(() => expect(screen.queryByText("New Delhi")).not.toBeInTheDocument());
  });
});
