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
// Usage:
//   node scripts/fetch-gazetteer.mjs           build if missing
//   node scripts/fetch-gazetteer.mjs --check   verify (offline, no network)
//   node scripts/fetch-gazetteer.mjs --force   rebuild
//
// Output is TSV, not JSON: 34k rows of `{"name":…}` costs about three times as
// much, and the client parses this with a split().

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public/map/gazetteer.tsv");
const UPSTREAM = process.env.GEONAMES_DUMP || "https://download.geonames.org/export/dump";

/** GeoNames column indexes we read; the dump has 19 and we want six of them. */
const NAME = 1;
const LAT = 4;
const LNG = 5;
const COUNTRY = 8;
const ADMIN1 = 10;
const POPULATION = 14;

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const force = args.has("--force");

/** A row is only useful if it has a name and a position we can fly to. */
function usable(cols) {
  return cols[NAME] && Number.isFinite(+cols[LAT]) && Number.isFinite(+cols[LNG]);
}

async function download(file, dest) {
  const res = await fetch(`${UPSTREAM}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gazetteer-"));
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

  const rows = [];
  for (const line of fs.readFileSync(path.join(tmp, "cities15000.txt"), "utf8").split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!usable(cols)) continue;
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
      ].join("\t"),
    );
  }

  // Most-populous first, so the client can stop scanning once it has enough
  // matches and still show the place the operator almost certainly meant.
  rows.sort((a, b) => +b.split("\t")[5] - +a.split("\t")[5]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.join("\n") + "\n");
  fs.rmSync(tmp, { recursive: true, force: true });
  return rows.length;
}

const exists = fs.existsSync(OUT);

if (check) {
  if (!exists) {
    console.error(`MISSING ${path.relative(ROOT, OUT)} — run: node scripts/fetch-gazetteer.mjs`);
    process.exit(1);
  }
  const lines = fs.readFileSync(OUT, "utf8").trim().split("\n");
  const bad = lines.findIndex((l) => l.split("\t").length !== 6);
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
