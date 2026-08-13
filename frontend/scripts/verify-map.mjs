// Smoke-tests a RUNNING deployment's offline map: every byte the Sites Map needs
// must come back from the given origin, and the tile archive must actually
// contain the layers the style draws.
//
// Worth running on the air-gapped host after copying the archive over — it
// catches the two failures that otherwise show up as a blank map: a tiles volume
// that was never mounted, and an archive built from a different tile schema than
// the style expects.
//
// Usage:
//   node scripts/verify-map.mjs                        against http://127.0.0.1:3000
//   node scripts/verify-map.mjs --base=http://host     against a deployed gateway

import { PMTiles } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";

import { ATTRIBUTION, DEFAULT_TILES_URL, GLYPHS_URL, SPRITE_URL, SOURCE_ID } from "../src/lib/map/config.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const TILES = arg("tiles", DEFAULT_TILES_URL);

let failures = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL ${msg}`);
};

async function head(url) {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-15" } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: e.message };
  }
}

// Every font stack referenced anywhere in the style's `text-font` expressions.
function fontStacks(styleLayers) {
  const stacks = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, val] of Object.entries(v)) {
        if (k === "text-font") JSON.stringify(val).match(/"Noto[^"]*"/g)?.forEach((s) => stacks.add(s.slice(1, -1)));
        else walk(val);
      }
  };
  walk(styleLayers);
  return stacks;
}

const styleLayers = layers(SOURCE_ID, namedFlavor("dark"), { lang: "en" });

console.log(`\nOffline map check — ${BASE}\n`);

// ── 1. the archive ─────────────────────────────────────────────────────────
console.log("tiles");
const tilesUrl = TILES.startsWith("http") ? TILES : `${BASE}${TILES}`;
let archive;
try {
  archive = new PMTiles(tilesUrl);
  const header = await archive.getHeader();
  ok(`archive served, z${header.minZoom}–${header.maxZoom}`);

  const meta = await archive.getMetadata();
  const present = new Set((meta.vector_layers || []).map((l) => l.id));
  const needed = [...new Set(styleLayers.map((l) => l["source-layer"]).filter(Boolean))];
  const missing = needed.filter((n) => !present.has(n));
  if (missing.length) fail(`archive is missing source-layers the style draws: ${missing.join(", ")}`);
  else ok(`all ${needed.length} source-layers present`);

  const tile = await archive.getZxy(Math.min(2, header.maxZoom), 2, 1);
  if (tile?.data?.byteLength) ok(`range read works (${tile.data.byteLength} bytes)`);
  else fail("range read returned no tile data — is the server stripping Range support?");
} catch (e) {
  fail(`cannot read ${tilesUrl} — ${e.message}`);
  console.log("       Build one with `npm run map:tiles` and mount it into the tiles service.");
}

// ── 2. glyphs and sprites ──────────────────────────────────────────────────
console.log("\nlabels");
for (const stack of fontStacks(styleLayers)) {
  const url = `${BASE}${GLYPHS_URL.replace("{fontstack}", encodeURIComponent(stack)).replace("{range}", "0-255")}`;
  const res = await head(url);
  res.ok ? ok(`glyphs ${stack}`) : fail(`glyphs ${stack} — HTTP ${res.status}`);
}
for (const ext of ["json", "png"]) {
  const res = await head(`${BASE}${SPRITE_URL}.${ext}`);
  res.ok ? ok(`sprite .${ext}`) : fail(`sprite .${ext} — HTTP ${res.status}`);
}

// ── 3. nothing points off-box ──────────────────────────────────────────────
console.log("\nisolation");
const style = { version: 8, glyphs: GLYPHS_URL, sprite: SPRITE_URL, layers: styleLayers };
const urls = JSON.stringify(style).match(/https?:[^"]*/g) || [];
// The ODbL attribution link is a plain <a href> in the map's corner — never fetched.
const offBox = [...new Set(urls)].filter((u) => !ATTRIBUTION.includes(u));
if (offBox.length) fail(`style references external hosts: ${offBox.join(", ")}`);
else ok("style references no external hosts");

console.log(failures ? `\n✗ ${failures} check(s) failed\n` : "\n✓ offline map is fully self-hosted\n");
// exitCode, not process.exit(): the PMTiles fetch source keeps a handle open, and
// tearing the loop down under it trips a libuv assertion on Windows.
process.exitCode = failures ? 1 : 0;
