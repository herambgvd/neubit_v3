"use client";

// Place search for the offline map picker.
//
// The dataset is public/map/gazetteer.tsv, built by scripts/fetch-gazetteer.mjs
// from GeoNames cities15000 (CC BY 4.0) and committed for the same reason the
// label glyphs are: an air-gapped site must be able to rebuild without reaching
// the internet. ~34k places, 1.8 MB on disk and about a third of that on the
// wire.
//
// It is a CITY gazetteer, not a street geocoder — deliberately. A self-hosted
// street geocoder is a full OSM import (tens of GB and a second Postgres), and an
// online one would send every site's address off the box. Flying to the right
// city and clicking the exact building is what the picker was always for; this
// only removes the part where the operator drags the whole world to get there.
//
// The file is fetched ONCE, on the first search, and only from a picker that is
// already open — never at page load.

/** Where the built file is served from. Same origin, like the glyphs and sprites. */
export const GAZETTEER_URL = "/map/gazetteer.tsv";

export interface Place {
  name: string;
  /** Names the place is still called: Gurgaon for Gurugram, Bombay for Mumbai. */
  alternates: string[];
  /** State / province, blank for the places GeoNames has none for. */
  region: string;
  country: string;
  lat: number;
  lng: number;
  population: number;
  /** "New Delhi, Delhi, India" — what the result row shows. */
  label: string;
}

/** A query that IS a position, so it needs no lookup at all. */
export interface Coordinate {
  lat: number;
  lng: number;
}

// Diacritics are stripped so "Malmo" finds "Malmö" and "Duesseldorf" does not
// have to be spelled the way the operator's keyboard cannot.
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * "28.6215, 77.2148" — and the forms an operator actually pastes: a space or a
 * slash instead of a comma, and a stray degree sign from a copied web page.
 *
 * Returns null rather than a guess when either half is out of range, because a
 * swapped pair (77, 28) is a valid-looking point in the wrong hemisphere.
 */
export function parseCoordinate(query: string): Coordinate | null {
  const cleaned = query.replace(/[°\s]+/g, " ").trim();
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*[,/ ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * True while the query could still BECOME a coordinate — digits, separators and
 * signs only. Typing "28.6139, 77.2090" passes through "28.6139", which is not a
 * coordinate yet and is also not a place: without this the picker downloads the
 * whole place list mid-paste, for a query that will never use it.
 */
export function looksNumeric(query: string): boolean {
  const trimmed = query.trim();
  return trimmed !== "" && /^[-\d.,/\s\u00b0]+$/.test(trimmed);
}

/** Parsed rows, and the in-flight request, so concurrent searches share one fetch. */
let cache: Place[] | null = null;
let inFlight: Promise<Place[]> | null = null;

export function parseGazetteer(text: string): Place[] {
  const places: Place[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [name, region, country, lat, lng, population, alternates] = line.split("\t");
    if (!name || !lat || !lng) continue;
    places.push({
      name,
      alternates: alternates ? alternates.split("|").filter(Boolean) : [],
      region: region || "",
      country: country || "",
      lat: +lat,
      lng: +lng,
      population: +population || 0,
      label: [name, region, country].filter(Boolean).join(", "),
    });
  }
  return places;
}

/** Thrown state is not cached: a failed load must be retryable on the next keystroke. */
export async function loadGazetteer(url = GAZETTEER_URL): Promise<Place[]> {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`gazetteer: HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        cache = parseGazetteer(text);
        return cache;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetGazetteer(): void {
  cache = null;
  inFlight = null;
}

/**
 * Ranking, best first:
 *   0  the name IS the query          ("delhi" → Delhi, before New Delhi)
 *   1  the name STARTS WITH the query ("new de" → New Delhi)
 *   2  a later word starts with it    ("delhi" → New Delhi)
 *   3  an ALTERNATE name matches      ("gurgaon" → Gurugram)
 *   4  region or country matches      ("maharashtra" → its cities)
 * Ties break on population, which is why the file is written most-populous first.
 *
 * Alternates sit BELOW every real-name match on purpose: they are old and foreign
 * names, and one of them must never outrank a place actually called that today.
 */
function rank(place: Place, query: string): number {
  const name = normalize(place.name);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[\s-]+/).some((word) => word.startsWith(query))) return 2;
  if (place.alternates.some((alt) => normalize(alt).startsWith(query))) return 3;
  if (normalize(`${place.region} ${place.country}`).includes(query)) return 4;
  return -1;
}

function match(places: Place[], query: string, limit: number): Place[] {
  const scored: { place: Place; rank: number }[] = [];
  for (const place of places) {
    const r = rank(place, query);
    if (r !== -1) scored.push({ place, rank: r });
  }
  scored.sort((a, b) => a.rank - b.rank || b.place.population - a.place.population);
  return scored.slice(0, limit).map((s) => s.place);
}

/**
 * The phrases to try when the whole query matches nothing — an operator pastes a
 * full address ("Star Tower Sector 30 Gurgaon"), and the only part this file can
 * possibly know is the town, which is almost always at the END.
 *
 * So: trailing phrases, longest first — "sector 30 gurgaon", "30 gurgaon",
 * "gurgaon". Longest-first matters because "new delhi" must be tried before
 * "delhi", or a Connaught Place address lands on the wrong one of the two.
 */
export function fallbackPhrases(rawQuery: string, maxWords = 3): string[] {
  const words = normalize(rawQuery).split(/[\s,]+/).filter(Boolean);
  if (words.length < 2) return [];
  const phrases: string[] = [];
  for (let take = Math.min(maxWords, words.length - 1); take >= 1; take--) {
    phrases.push(words.slice(words.length - take).join(" "));
  }
  return phrases;
}

export function searchPlaces(places: Place[], rawQuery: string, limit = 8): Place[] {
  const query = normalize(rawQuery);
  if (query.length < 2) return [];

  const direct = match(places, query, limit);
  if (direct.length) return direct;

  // Nothing matched the whole string. Fall back to the trailing phrases — a city
  // gazetteer cannot know the building, but it does know the town it is in, and
  // flying there beats telling the operator to drag the world.
  for (const phrase of fallbackPhrases(rawQuery)) {
    if (phrase.length < 3) continue;
    const hits = match(places, phrase, limit);
    if (hits.length) return hits;
  }
  return [];
}

/** How close to zoom in on a chosen place — a metropolis needs more room than a town. */
export function zoomForPlace(place: Place): number {
  if (place.population > 2_000_000) return 10;
  if (place.population > 300_000) return 11;
  return 12;
}
