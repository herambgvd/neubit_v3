// Builds the OFFLINE Iconify bundle.
//
// Why: `@iconify/react`'s <Icon icon="heroicons-outline:camera" /> fetches icon
// data from api.iconify.design at runtime. On an air-gapped install every icon
// in the console renders blank. Same for the handful of `content: url(...)`
// icons our SCSS pulls from that API.
//
// This script is the ONLY place that talks to the Iconify API, and it runs on a
// developer machine — never at build or run time. It scans src/ for every
// `"prefix:name"` icon literal, downloads exactly those icons once, and writes
// two committed artefacts:
//
//   src/lib/icons/icon-bundle.json   → registered with addCollection() at boot
//   src/styles/scss/_icon-assets.scss → data: URIs for the CSS-only icons
//
// Re-run it (with network) after adding a new icon:  npm run icons
//
// Usage: node scripts/build-icon-bundle.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const API = process.env.ICONIFY_API || "https://api.iconify.design";

// Icon-set prefixes we actually ship. Whitelisting keeps false positives out:
// plenty of unrelated strings ("sm:hover", "09:00") match the prefix:name shape.
const COLLECTIONS = [
  "heroicons",
  "heroicons-outline",
  "heroicons-solid",
  "heroicons-mini",
  "svg-spinners",
  "mdi",
  "akar-icons",
];

// CSS-only icons: SCSS `content: url()` rules can't use the React component, so
// each of these is baked into _icon-assets.scss as a data: URI instead.
const CSS_ICONS = [
  { var: "check-white", icon: "heroicons-outline:check", color: "white" },
  { var: "chevron-right-white", icon: "heroicons-outline:chevron-right", color: "white", width: 24 },
  { var: "chevron-left-white", icon: "heroicons-outline:chevron-left", color: "white", width: 24 },
  { var: "calendar", icon: "heroicons:calendar", width: 18, height: 18 },
  { var: "calendar-white", icon: "heroicons:calendar", color: "white", width: 18, height: 18 },
  { var: "filter", icon: "heroicons-outline:filter", width: 18, height: 18 },
  { var: "filter-white", icon: "heroicons-outline:filter", color: "white", width: 18, height: 18 },
];

// Heroicons v1 → v2 rescue map. The console asks for names that the v1 sets
// (`heroicons-outline`/`heroicons-solid`) never had, and for a `heroicons-mini`
// prefix that Iconify doesn't publish at all — those icons render blank today,
// online included. Rather than touch 200-odd call sites, we look each missing
// name up in the v2 `heroicons` set and splice it into the bundle under the name
// the source already uses. Candidates are tried in order.
const V2_FALLBACKS = {
  "heroicons-outline": (n) => [n, `${n}-20-solid`],
  "heroicons-solid": (n) => [`${n}-solid`, `${n}-20-solid`, n],
  "heroicons-mini": (n) => [`${n}-20-solid`, `${n}-16-solid`, `${n}-solid`, n],
};

const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const SCAN_EXT = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".scss", ".css"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// `"heroicons-outline:camera"` in JSX props, object literals, lookup tables — all
// of them are plain quoted strings, so one regex over the source catches the lot.
const LITERAL = /["'`]([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)["'`]/g;

function collectUsedIcons() {
  const used = new Map(); // prefix -> Set(name)
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, prefix, name] of text.matchAll(LITERAL)) {
      if (!COLLECTIONS.includes(prefix)) continue;
      if (!used.has(prefix)) used.set(prefix, new Set());
      used.get(prefix).add(name);
    }
  }
  for (const { icon } of CSS_ICONS) {
    const [prefix, name] = icon.split(":");
    if (!used.has(prefix)) used.set(prefix, new Set());
    used.get(prefix).add(name);
  }
  return used;
}

// The API rejects over-long query strings, so ask in batches and merge.
function batchNames(names, maxChars = 1000) {
  const batches = [[]];
  let len = 0;
  for (const name of [...names].sort()) {
    if (len + name.length + 1 > maxChars && batches.at(-1).length) {
      batches.push([]);
      len = 0;
    }
    batches.at(-1).push(name);
    len += name.length + 1;
  }
  return batches.filter((b) => b.length);
}

async function fetchCollection(prefix, names) {
  const data = { prefix, icons: {}, aliases: {} };
  for (const batch of batchNames(names)) {
    const url = `${API}/${prefix}.json?icons=${batch.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${prefix}: HTTP ${res.status} from ${API}`);
    const chunk = await res.json();
    // An entirely unknown prefix answers 200 with a bare `404` body. Treat it as
    // "nothing here" — every name falls through to the v2 rescue pass.
    if (chunk === 404) continue;
    if (typeof chunk !== "object" || chunk === null) {
      throw new Error(`${prefix}: unexpected response ${JSON.stringify(chunk)} for ${url}`);
    }
    Object.assign(data.icons, chunk.icons);
    Object.assign(data.aliases, chunk.aliases);
    // Collection-level defaults are identical across batches; keep the first seen.
    if (chunk.width && !data.width) data.width = chunk.width;
    if (chunk.height && !data.height) data.height = chunk.height;
  }
  const missing = [...names].filter((n) => !data.icons[n] && !data.aliases[n]);
  if (missing.length) console.warn(`  ! ${prefix}: not found → ${missing.join(", ")}`);
  // Drop the metadata blocks the renderer never reads; they double the file size.
  return { data, found: Object.keys(data.icons).length, missing };
}

// Render one icon to a standalone SVG string, mirroring what the Iconify API's
// /prefix/name.svg endpoint returns (that's what the SCSS used to request).
function renderSvg(collection, name, { color, width, height }) {
  let entry = collection.icons?.[name];
  let alias = collection.aliases?.[name];
  while (!entry && alias) {
    entry = collection.icons?.[alias.parent];
    alias = collection.aliases?.[alias.parent];
  }
  if (!entry) throw new Error(`icon ${collection.prefix}:${name} missing from bundle`);

  const vbW = entry.width || collection.width || 16;
  const vbH = entry.height || collection.height || 16;
  const w = width || (height ? Math.round((height * vbW) / vbH) : vbW);
  const h = height || (width ? Math.round((width * vbH) / vbW) : vbH);
  const body = color ? entry.body.replaceAll("currentColor", color) : entry.body;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${vbW} ${vbH}">${body}</svg>`
  );
}

function writeScssAssets(byPrefix) {
  const lines = [
    "// GENERATED by scripts/build-icon-bundle.mjs — do not edit by hand.",
    "//",
    "// Data: URIs for the icons used from CSS `content: url()`, which can't go",
    "// through the <Icon> component. Inlined so a network-less install still",
    "// paints them (they used to be fetched from api.iconify.design).",
    "",
  ];
  for (const spec of CSS_ICONS) {
    const [prefix, name] = spec.icon.split(":");
    const svg = renderSvg(byPrefix[prefix], name, spec);
    const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    lines.push(`// ${spec.icon}`);
    lines.push(`$icon-${spec.var}: url("${uri}");`);
  }
  const target = path.join(SRC, "styles/scss/_icon-assets.scss");
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  return target;
}

// Pull `wanted` (v2 names) out of the heroicons set and hand back a lookup of
// fully-resolved icon entries — aliases flattened, width/height made explicit so
// each one survives being re-homed under a collection with different defaults.
async function fetchV2Rescues(wanted) {
  if (!wanted.size) return {};
  const { data } = await fetchCollection("heroicons", wanted);
  const out = {};
  for (const name of wanted) {
    let entry = data.icons?.[name];
    let alias = data.aliases?.[name];
    while (!entry && alias) {
      entry = data.icons?.[alias.parent];
      alias = data.aliases?.[alias.parent];
    }
    if (entry) {
      out[name] = {
        ...entry,
        width: entry.width || data.width || 24,
        height: entry.height || data.height || 24,
      };
    }
  }
  return out;
}

// `--check`: offline audit. Confirms the committed bundle still covers every
// icon the source asks for, so a newly added <Icon icon="…"/> that nobody
// regenerated for can't quietly ship as a blank square. Needs no network.
function check() {
  const jsonPath = path.join(SRC, "lib/icons/icon-bundle.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`${path.relative(ROOT, jsonPath)} is missing — run: npm run icons`);
  }
  const bundle = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const byPrefix = Object.fromEntries(bundle.map((c) => [c.prefix, c]));
  const used = collectUsedIcons();
  const gaps = [];

  for (const [prefix, names] of used) {
    const collection = byPrefix[prefix];
    for (const name of names) {
      if (!collection?.icons?.[name] && !collection?.aliases?.[name]) gaps.push(`${prefix}:${name}`);
    }
  }
  if (gaps.length) {
    throw new Error(`${gaps.length} icon(s) not in the bundle — run \`npm run icons\`:\n  ${gaps.join("\n  ")}`);
  }
  const count = bundle.reduce((n, c) => n + Object.keys(c.icons || {}).length, 0);
  console.log(`✓ every icon used in src/ is bundled (${count} icons, ${bundle.length} collections)`);
}

async function main() {
  if (process.argv.includes("--check")) return check();

  const used = collectUsedIcons();
  const fetched = [];
  let total = 0;

  for (const prefix of COLLECTIONS) {
    const names = used.get(prefix);
    if (!names?.size) continue;
    console.log(`→ ${prefix}: ${names.size} icons`);
    const { data, found, missing } = await fetchCollection(prefix, names);
    fetched.push({ prefix, data, missing });
    total += found;
  }

  // Second pass: everything the v1 sets couldn't supply, sourced from heroicons v2.
  const rescueNames = new Set();
  for (const { prefix, missing } of fetched) {
    const candidates = V2_FALLBACKS[prefix];
    if (!candidates) continue;
    for (const name of missing) for (const c of candidates(name)) rescueNames.add(c);
  }
  const rescues = await fetchV2Rescues(rescueNames);

  for (const { prefix, data, missing } of fetched) {
    const candidates = V2_FALLBACKS[prefix];
    if (!candidates) continue;
    const healed = [];
    for (const name of missing) {
      const hit = candidates(name).find((c) => rescues[c]);
      if (!hit) continue;
      data.icons = data.icons || {};
      data.icons[name] = rescues[hit];
      healed.push(`${name}←${hit}`);
      total += 1;
    }
    if (healed.length) console.log(`  ↺ ${prefix} healed from heroicons v2: ${healed.join(", ")}`);
    const stillMissing = missing.filter((n) => !data.icons?.[n]);
    if (stillMissing.length) console.warn(`  ✗ ${prefix} unresolved: ${stillMissing.join(", ")}`);
  }

  const bundle = fetched.map(({ data }) => data);
  const byPrefix = Object.fromEntries(fetched.map(({ prefix, data }) => [prefix, data]));

  const jsonDir = path.join(SRC, "lib/icons");
  fs.mkdirSync(jsonDir, { recursive: true });
  const jsonPath = path.join(jsonDir, "icon-bundle.json");
  fs.writeFileSync(jsonPath, `${JSON.stringify(bundle)}\n`, "utf8");

  const scssPath = writeScssAssets(byPrefix);

  const kb = (fs.statSync(jsonPath).size / 1024).toFixed(1);
  console.log(`\n✓ ${total} icons → ${path.relative(ROOT, jsonPath)} (${kb} KB)`);
  console.log(`✓ ${CSS_ICONS.length} data: URIs → ${path.relative(ROOT, scssPath)}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
