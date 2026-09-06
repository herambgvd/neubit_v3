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
