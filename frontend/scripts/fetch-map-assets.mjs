// Downloads the MapLibre basemap assets — label glyphs and POI sprites — into
// public/map/, where they are COMMITTED.
//
// Why committed rather than fetched at build time: an air-gapped site has to be
// able to rebuild the image without reaching protomaps.github.io. The whole set
// is ~11 MB, the same order as the h265web WASM decoder we already ship.
//
// Usage:
//   node scripts/fetch-map-assets.mjs           download anything missing
//   node scripts/fetch-map-assets.mjs --check   verify (offline, no network)
//   node scripts/fetch-map-assets.mjs --force   re-download everything
//
// Tiles are NOT handled here — the planet basemap is a multi-GB PMTiles archive
// that ships as a deployment volume. See scripts/fetch-planet-tiles.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public/map");
const UPSTREAM = process.env.BASEMAPS_ASSETS || "https://protomaps.github.io/basemaps-assets";

// The font stacks the Protomaps dark flavor asks for. Keep in sync with the style
// built in src/lib/map/index.js — `npm run map:verify` fails loudly if a stack the
// style references has no glyphs on disk.
const FONTS = [
  "Noto Sans Regular",
  "Noto Sans Medium",
  "Noto Sans Italic",
  "Noto Sans Devanagari Regular v1",
];

const SPRITES = ["dark.json", "dark.png", "dark@2x.json", "dark@2x.png"];

// Glyph ranges MapLibre renders from system fonts instead of downloading, via
// its `localIdeographFontFamily` option (CJK, Hangul, kana, fullwidth forms).
// Noto Sans carries no glyphs for these anyway — the .pbf files are empty
// shells — so skipping them drops 156 of 256 ranges per family for ~0 bytes.
const LOCAL_IDEOGRAPH_BLOCKS = [
  [0x3000, 0x30ff], // CJK symbols, hiragana, katakana
  [0x3400, 0x9fff], // CJK unified ideographs (+ extension A)
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // halfwidth & fullwidth forms
];

function glyphRanges() {
  const ranges = [];
  for (let start = 0; start < 65536; start += 256) {
    const local = LOCAL_IDEOGRAPH_BLOCKS.some(([lo, hi]) => start >= lo && start <= hi);
    if (!local) ranges.push(`${start}-${start + 255}`);
  }
  return ranges;
}

// [url, destination] for every asset the map needs.
function manifest() {
  const items = [];
  for (const font of FONTS) {
    for (const range of glyphRanges()) {
      items.push({
        url: `${UPSTREAM}/fonts/${encodeURIComponent(font)}/${range}.pbf`,
        dest: path.join(OUT, "fonts", font, `${range}.pbf`),
      });
    }
  }
  for (const sprite of SPRITES) {
    items.push({
      url: `${UPSTREAM}/sprites/v4/${sprite}`,
      dest: path.join(OUT, "sprites", sprite),
    });
  }
  return items;
}

async function download({ url, dest }) {
  const res = await fetch(url);
  // A range with no glyphs in this face 404s upstream. That is not an error —
  // MapLibre simply falls back for those code points.
  if (res.status === 404) return { skipped: true };
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return { bytes: body.length };
}

// Bounded concurrency — 400-odd small files, but let's not open 400 sockets.
async function pool(items, worker, limit = 8) {
  let cursor = 0;
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

function check() {
  const missing = [];
  for (const font of FONTS) {
    const dir = path.join(OUT, "fonts", font);
    const count = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".pbf")).length : 0;
    if (count === 0) missing.push(`fonts/${font} (no glyph ranges)`);
  }
  for (const sprite of SPRITES) {
    if (!fs.existsSync(path.join(OUT, "sprites", sprite))) missing.push(`sprites/${sprite}`);
  }
  if (missing.length) {
    throw new Error(
      `map assets missing — run \`npm run map:assets\`:\n  ${missing.join("\n  ")}`,
    );
  }
  const glyphs = FONTS.reduce(
    (n, f) => n + fs.readdirSync(path.join(OUT, "fonts", f)).length,
    0,
  );
  console.log(`✓ basemap assets present (${FONTS.length} font stacks, ${glyphs} glyph ranges, ${SPRITES.length} sprite files)`);
}

async function main() {
  if (process.argv.includes("--check")) return check();
  const force = process.argv.includes("--force");

  const items = manifest().filter((i) => force || !fs.existsSync(i.dest));
  if (!items.length) {
    console.log("✓ nothing to do — every asset is already in public/map/");
    return check();
  }

  console.log(`↓ ${items.length} file(s) from ${UPSTREAM}`);
  let bytes = 0;
  let skipped = 0;
  const results = await pool(items, async (item) => {
    const r = await download(item);
    if (r.skipped) skipped += 1;
    else bytes += r.bytes;
    return r;
  });

  console.log(
    `\n✓ ${results.length - skipped} file(s), ${(bytes / 1048576).toFixed(1)} MB → ${path.relative(ROOT, OUT)}` +
      (skipped ? ` (${skipped} empty range(s) skipped upstream)` : ""),
  );
  check();
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
