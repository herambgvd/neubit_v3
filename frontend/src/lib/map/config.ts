// Plain constants for the offline basemap, kept apart from ./index.js so a module
// can name the tiles URL without importing MapLibre GL — that import is ~800 KB
// and belongs only in the code-split map canvas.

// Default archive location, matching the Traefik route in deploy/docker-compose.yml.
// A super-admin can point elsewhere via Platform Settings → Maps.
export const DEFAULT_TILES_URL = "/tiles/planet.pmtiles";

// Both are same-origin paths, resolved by MapLibre against the document base URL.
// public/map/ is populated by scripts/fetch-map-assets.mjs and committed.
export const GLYPHS_URL = "/map/fonts/{fontstack}/{range}.pbf";
export const SPRITE_URL = "/map/sprites/dark";

export const SOURCE_ID = "protomaps";

// ODbL requires attribution wherever OSM-derived tiles are shown.
export const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Is this rejection just a cancelled tile?
 *
 * Zooming cancels every in-flight tile request — that is how a map is supposed
 * to behave, not a fault. pmtiles' protocol handler calls
 * `signal.throwIfAborted()`, which throws a DOMException named "AbortError", and
 * somewhere between that throw and MapLibre's own abort handling one of them
 * escapes as an unhandled rejection. In production it is console noise; in dev,
 * Next's overlay turns it into a blocking modal over the map.
 *
 * It lives HERE and not in ./index for the reason this file exists at all: ./index
 * imports MapLibre GL, which cannot even be loaded in a jsdom test — so a rule
 * kept beside it would be untestable. It matches ONLY an abort, by name, on a
 * DOMException or an Error alike (DOMException extends Error in a browser but not
 * in jsdom, so `instanceof` is the wrong test).
 */
export function isTileAbort(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  return (reason as { name?: unknown }).name === "AbortError";
}
