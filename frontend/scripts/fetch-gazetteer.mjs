// Builds public/map/gazetteer.tsv — the place list the offline map picker
// searches, so an operator can type "New Delhi" instead of dragging the world.
//
// Why a committed file and not a geocoder: a self-hosted geocoder means a full
// OSM import (tens of GB and a second Postgres), and an online one would send
// every site's address off the box — which an air-gapped install cannot do and a
// security customer should not want. A city gazetteer is the proportionate
// middle: it flies the map to the right city, and the operator clicks the exact
// building, which is what the picker was always for.
//
// Source: GeoNames cities15000 (every place over 15,000 people, ~34k rows),
// licensed CC BY 4.0 — attribution ships in the picker's UI.
//
// Seven tab-separated columns: name, region, country, lat, lng, population, and
// pipe-separated alternate names (see `alternates` below — that column is why
// "Gurgaon" finds Gurugram).
//
// Usage:
//   node scripts/fetch-gazetteer.mjs           build if missing
//   node scripts/fetch-gazetteer.mjs --check   verify (offline, no network)
//   node scripts/fetch-gazetteer.mjs --force   rebuild from the cached dumps
//   node scripts/fetch-gazetteer.mjs --refresh re-download the dumps too
//
// Output is TSV, not JSON: 34k rows of `{"name":…}` costs about three times as
// much, and the client parses this with a split().

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public/map/gazetteer.tsv");
// The dumps are cached here (gitignored) — alternateNamesV2 alone is 204 MB, and
// rebuilding should not re-fetch it.
const CACHE = path.join(ROOT, "node_modules/.cache/gazetteer");
const UPSTREAM = process.env.GEONAMES_DUMP || "https://download.geonames.org/export/dump";

/** GeoNames column indexes we read; the dump has 19 and we want seven of them. */
const GEONAME_ID = 0;
const NAME = 1;
const LAT = 4;
const LNG = 5;
const COUNTRY = 8;
const ADMIN1 = 10;
const POPULATION = 14;

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const force = args.has("--force");

/**
 * Alternate names, and why they come from a SEPARATE 204 MB download rather than
 * the `alternatenames` column that is right there in cities15000.
 *
 * That column lists every transliteration in every script, alphabetically, with
 * no marking of which is the real English name. Taking the first few ASCII
 * entries gives Mumbai "Asumumbay, BOM, Bombai, Bombaim, Bombaj" — and stops one
 * short of "Bombay", the only one anybody types. Raising the cap until the useful
 * name is reached carries four junk entries per city to get it.
 *
 * alternateNamesV2 has the language and the preferred/short flags, so we can ask
 * for the English name instead of guessing at it. The download is build-time
 * only; what ships is the ~2 alternates per city that survive.
 *
 * This column is why "Gurgaon" finds Gurugram, "Bombay" finds Mumbai and
 * "Bangalore" finds Bengaluru — the renamings an operator still types.
 */
const MAX_ALTERNATES = 4;
const ASCII = /^[\x20-\x7e]+$/;

/** alternateNamesV2 columns. */
const ALT_GEONAME_ID = 1;
const ALT_LANG = 2;
const ALT_NAME = 3;
const ALT_PREFERRED = 4;
const ALT_SHORT = 5;
const ALT_COLLOQUIAL = 6;
const ALT_HISTORIC = 7;

/**
 * Reads alternateNamesV2 for the ids we actually kept, and returns
 * `id -> "Gurgaon|Guragaon"`. `names` is `id -> canonical name`, so an "alternate"
 * that merely repeats the name can be dropped.
 *
 * Streams by line: the unzipped file is ~1.5 GB and reading it whole would need
 * more heap than a build machine should have to give.
 */
async function readAlternates(file, names) {
  const found = new Map();
  const stream = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  for await (const line of stream) {
    const cols = line.split("\t");
    const id = cols[ALT_GEONAME_ID];
    if (!names.has(id)) continue;

    const name = cols[ALT_NAME];
    if (!name || name.length > 30 || !ASCII.test(name)) continue;
    // Colloquial names are nicknames ("The Big Apple") — not what goes in a form.
    // HISTORIC names are kept, and that is not an oversight: a renamed city marks
    // its old name historic, so excluding them threw away the exact strings this
    // column exists for. Gurgaon, Bombay and Calcutta are all flagged historic.
    if (cols[ALT_COLLOQUIAL] === "1") continue;

    const english = cols[ALT_LANG] === "en";
    const preferred = cols[ALT_PREFERRED] === "1";
    const short = cols[ALT_SHORT] === "1";
    if (!english && !preferred && !short) continue;

    // Rank so the ones most likely to be typed survive the cap: an explicitly
    // preferred English name first, any English name next, then the rest.
    const score = (english ? 0 : 2) + (preferred || short ? 0 : 1);
    // An alternate identical to the place's own name is not an alternate.
    if (name.toLowerCase() === (names.get(id) || "").toLowerCase()) continue;
    const list = found.get(id) || [];
    list.push({ name, score });
    found.set(id, list);
  }

  const out = new Map();
  for (const [id, list] of found) {
    list.sort((a, b) => a.score - b.score);
    const seen = new Set();
    const names = [];
    for (const { name } of list) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= MAX_ALTERNATES) break;
    }
    // "|" and not "," — a comma would be ambiguous inside a name like "Washington, D.C."
    out.set(id, names.join("|"));
  }
  return out;
}

/** A row is only useful if it has a name and a position we can fly to. */
function usable(cols) {
  return cols[NAME] && Number.isFinite(+cols[LAT]) && Number.isFinite(+cols[LNG]);
}

async function download(file, dest) {
  if (fs.existsSync(dest) && !args.has("--refresh")) return;
  const res = await fetch(`${UPSTREAM}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** `IN.DL -> "Delhi"`, so a result reads as a place and not as a code. */
function readAdmin1(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const [code, name] = line.split("\t");
    if (code && name) map.set(code, name);
  }
  return map;
}

/** `IN -> "India"`. countryInfo.txt is comment-prefixed; skip those lines. */
function readCountries(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols[0] && cols[4]) map.set(cols[0], cols[4]);
  }
  return map;
}

async function build() {
  const tmp = CACHE;
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, "cities15000.zip");

  await download("cities15000.zip", zip);
  // The dump is only published zipped; unzip is present on every platform we build on.
  execFileSync("unzip", ["-o", "-q", zip, "-d", tmp]);

  const [admin1Raw, countryRaw] = await Promise.all(
    ["admin1CodesASCII.txt", "countryInfo.txt"].map(async (f) => {
      const res = await fetch(`${UPSTREAM}/${f}`);
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      return res.text();
    }),
  );
  const admin1 = readAdmin1(admin1Raw);
  const countries = readCountries(countryRaw);

  // Two passes: collect the cities first, so the alternate-name scan knows which
  // of GeoNames' 20 million rows are worth keeping.
  const kept = [];
  for (const line of fs.readFileSync(path.join(tmp, "cities15000.txt"), "utf8").split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    if (usable(cols)) kept.push(cols);
  }

  const altZip = path.join(tmp, "alternateNamesV2.zip");
  await download("alternateNamesV2.zip", altZip);
  execFileSync("unzip", ["-o", "-q", altZip, "-d", tmp]);
  const alternates = await readAlternates(
    path.join(tmp, "alternateNamesV2.txt"),
    new Map(kept.map((c) => [c[GEONAME_ID], c[NAME]])),
  );

  const rows = [];
  for (const cols of kept) {
    const country = countries.get(cols[COUNTRY]) || cols[COUNTRY];
    const region = admin1.get(`${cols[COUNTRY]}.${cols[ADMIN1]}`) || "";
    // Region and country are written out in full rather than as codes. It looks
    // wasteful — "India" 3,000 times — but the file is served gzipped, and
    // repetition is the one thing gzip is best at.
    rows.push(
      [
        cols[NAME],
        region,
        country,
        (+cols[LAT]).toFixed(4),
        (+cols[LNG]).toFixed(4),
        cols[POPULATION] || "0",
        alternates.get(cols[GEONAME_ID]) || "",
      ].join("\t"),
    );
  }

  // Most-populous first, so the client can stop scanning once it has enough
  // matches and still show the place the operator almost certainly meant.
  rows.sort((a, b) => +b.split("\t")[5] - +a.split("\t")[5]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.join("\n") + "\n");
  // The cache is deliberately left behind — see CACHE.
  return rows.length;
}

const exists = fs.existsSync(OUT);

if (check) {
  if (!exists) {
    console.error(`MISSING ${path.relative(ROOT, OUT)} — run: node scripts/fetch-gazetteer.mjs`);
    process.exit(1);
  }
  const lines = fs.readFileSync(OUT, "utf8").trim().split("\n");
  const bad = lines.findIndex((l) => l.split("\t").length !== 7);
  if (bad !== -1) {
    console.error(`MALFORMED ${path.relative(ROOT, OUT)} at line ${bad + 1}`);
    process.exit(1);
  }
  console.log(`gazetteer OK — ${lines.length} places`);
} else if (exists && !force) {
  console.log(`gazetteer present — ${path.relative(ROOT, OUT)} (use --force to rebuild)`);
} else {
  const count = await build();
  const size = (fs.statSync(OUT).size / 1e6).toFixed(1);
  console.log(`gazetteer built — ${count} places, ${size} MB (gzips to roughly a third)`);
}
