"use client";

// Offline basemap plumbing for MapLibre.
//
// Nothing here touches the internet. The vector tiles are a PMTiles archive
// served from our own origin (see the `tiles` service in deploy/docker-compose.yml),
// the label glyphs and POI sprites are static files under public/map/, and the
// style itself is generated in-process from @protomaps/basemaps rather than
// fetched from a style server.
//
// Importing this module pulls in MapLibre GL. Anything that only needs to name
// the tiles URL should import ./config instead.
// maplibre-gl is PINNED TO v5 on purpose. Under v6 the pmtiles protocol never
// produces a source cache: the map builds, the sprite loads, and then it sits
// with isStyleLoaded() === false forever — no tile requests, no error event, just
// a blank canvas. pmtiles 4 and @protomaps/basemaps 5 both predate v6. Do not
// bump the major without re-running `npm run map:verify` AND checking a real map.
// v5 also has no default export — named imports only.
import { addProtocol } from "maplibre-gl";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { PMTiles, Protocol } from "pmtiles";

import { ATTRIBUTION, DEFAULT_TILES_URL, GLYPHS_URL, SOURCE_ID, SPRITE_URL } from "./config";

export { DEFAULT_TILES_URL, GLYPHS_URL, SOURCE_ID, SPRITE_URL } from "./config";

let protocol = null;

// MapLibre resolves `pmtiles://…` tile URLs through this handler, which reads the
// archive with HTTP range requests — so a 3.7 GB planet file costs only the few
// KB of tiles actually on screen.
export function ensurePmtilesProtocol() {
  if (!protocol) {
    protocol = new Protocol();
    addProtocol("pmtiles", protocol.tile);
  }
  return protocol;
}

// A complete MapLibre style spec — no style server, no CDN.
//
// The glyph and sprite paths are made ABSOLUTE against the page's own origin.
// MapLibre v6 rejects a relative sprite outright ("Invalid sprite URL …, must be
// absolute") and aborts the whole style load, which leaves the canvas stuck on
// "Loading map…". Still same-origin — this is a URL-form requirement, not a
// network one.
// `header` comes from probeTiles below. Declaring the source with an explicit
// tile template + zoom range, rather than `url: "pmtiles://…"`, keeps MapLibre
// off the protocol's TileJSON branch: under maplibre-gl v6 that handshake never
// resolves, and the map sits on "Loading map…" forever with no error. We already
// have the header from the probe, so there is nothing to ask for anyway.
export function offlineStyle(tilesUrl = DEFAULT_TILES_URL, header) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return {
    version: 8,
    glyphs: `${origin}${GLYPHS_URL}`,
    sprite: `${origin}${SPRITE_URL}`,
    sources: {
      [SOURCE_ID]: {
        type: "vector",
        tiles: [`pmtiles://${tilesUrl}/{z}/{x}/{y}`],
        minzoom: header?.minZoom ?? 0,
        maxzoom: header?.maxZoom ?? 15,
        bounds: header
          ? [header.minLon, header.minLat, header.maxLon, header.maxLat]
          : [-180, -85.051129, 180, 85.051129],
        attribution: ATTRIBUTION,
      },
    },
    layers: layers(SOURCE_ID, namedFlavor("dark"), { lang: "en" }),
  };
}

// Pre-flight the archive before building a map, and hand back its header so the
// style can declare the source's zoom range and bounds up front.
//
// MapLibre's own failure mode for an unreadable source is a silent black canvas,
// so this is what lets the UI say "basemap not installed" instead of just looking
// broken. On success the instance is handed to the protocol, so the header bytes
// read here are the same ones the map goes on to use.
export async function probeTiles(tilesUrl = DEFAULT_TILES_URL) {
  try {
    // Probe on a FRESH instance, and only hand it to the protocol once it works.
    // pmtiles' SharedPromiseCache caches the getHeader promise before it settles
    // and never evicts a rejected one, so registering first would poison the
    // shared instance: probe once while the tiles service is still extracting the
    // archive in the background, and every later probe in that page session
    // re-throws the same failure — the map stays on "basemap not installed" until
    // a full reload, long after the archive has landed.
    const archive = new PMTiles(tilesUrl);
    const header = await archive.getHeader();
    // 1 = MVT. A raster archive would load but draw nothing under a vector style.
    if (header.tileType !== 1) {
      return { ok: false, reason: `archive holds tile type ${header.tileType}, expected vector MVT` };
    }
    // Known-good: share the warm instance so the map reuses this header read.
    // `add` overwrites any earlier entry for the same URL.
    ensurePmtilesProtocol().add(archive);
    return { ok: true, header };
  } catch (e) {
    return { ok: false, reason: e.message || "unreachable" };
  }
}
