// Builds the OFFLINE Iconify bundle.
//
// Why: `@iconify/react`'s <Icon icon="heroicons-outline:camera" /> resolves a name
// it does not already hold by fetching it from api.iconify.design at runtime. On
// an air-gapped install every icon in the console renders blank — and silently,
// because Iconify treats an unresolvable name as "not ready yet", forever. Same
// for the handful of `content: url(...)` icons our SCSS used to pull from there.
//
// It scans src/ for every `"prefix:name"` icon literal and writes two committed
// artefacts containing EXACTLY those icons:
//
//   src/lib/icons/icon-bundle.json   → registered with addCollection() at boot
//   src/styles/scss/_icon-assets.scss → data: URIs for the CSS-only icons
//
// NO NETWORK. Icon data comes from the `@iconify-json/*` packages already in
// node_modules, so this runs in CI and on an air-gapped developer machine, and
// `npm run icons:check` can be a gate rather than advice. (It used to fetch from
// api.iconify.design, which meant a stale bundle could only be repaired by
// someone with internet — and so it stayed stale.)
//
// Re-run it after adding a new icon:  npm run icons
//
// Usage: node scripts/build-icon-bundle.mjs [--check]

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

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
// Tests name icons that must NOT be bundled — src/lib/icons.test.tsx asserts that
// an unresolvable name falls back to a visible glyph, and does it with a name
// chosen for not existing. Bundling those would make the assertion vacuous.
const SKIP_FILE = /\.test\.[jt]sx?$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXT.has(path.extname(entry.name)) && !SKIP_FILE.test(entry.name)) {
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

// ── mdi: three icons, not seven thousand ────────────────────────────────────
// The full Material Design Icons set is ~7,500 glyphs and several megabytes; the
// console uses three, and there is no @iconify-json/mdi in node_modules. They are
// inlined here rather than pulled in wholesale.
//
// ADDING AN MDI ICON: add it here too, or it will not render — `icons:check`
// will tell you. Copy the `body` from https://api.iconify.design/mdi.json?icons=<name>.
// Prefer a heroicons equivalent where one exists.
const INLINE_SETS = {
  mdi: {
    prefix: "mdi",
    width: 24,
    height: 24,
    icons: {
      "crop-free": {
        body: '<path fill="currentColor" d="M19 3h-4v2h4v4h2V5a2 2 0 0 0-2-2m0 16h-4v2h4a2 2 0 0 0 2-2v-4h-2M5 15H3v4a2 2 0 0 0 2 2h4v-2H5M3 5v4h2V5h4V3H5a2 2 0 0 0-2 2"/>',
      },
      "fit-to-screen-outline": {
        body: '<path fill="currentColor" d="M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3zm9-8v4H8v-4zm2-2H6v8h12z"/>',
      },
      leaf: {
        body: '<path fill="currentColor" d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66l.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75C7 8 17 8 17 8"/>',
      },
    },
  },
};

// The published set for a prefix, or null when we neither ship nor inline one.
// Loaded once — each of these files is megabytes, and `heroicons` is read twice
// (once for its own names, once for the v2 rescue pass).
const sourceCache = new Map();
function sourceSet(prefix) {
  if (!sourceCache.has(prefix)) {
    let set = INLINE_SETS[prefix] || null;
    if (!set) {
      try {
        set = require(`@iconify-json/${prefix}/icons.json`);
      } catch {
        set = null;
      }
    }
    sourceCache.set(prefix, set);
  }
  return sourceCache.get(prefix);
}

// Aliases are FLATTENED into concrete entries: an alias is a pointer into its own
// collection, and these names get re-homed under other prefixes by the v2 rescue
// pass below, where the parent it points at does not exist.
function resolveEntry(set, name) {
  let entry = set.icons?.[name];
  let alias = set.aliases?.[name];
  const seen = new Set();
  while (!entry && alias && !seen.has(alias.parent)) {
    seen.add(alias.parent);
    entry = set.icons?.[alias.parent];
    alias = set.aliases?.[alias.parent];
  }
  if (!entry) return null;
  // Width/height made explicit so the entry survives being re-homed under a
  // collection whose defaults differ (heroicons is 24px, heroicons-solid 20px).
  return { ...entry, width: entry.width || set.width || 24, height: entry.height || set.height || 24 };
}

function takeCollection(prefix, names) {
  const set = sourceSet(prefix);
  const data = { prefix, icons: {} };
  if (set) {
    if (set.width) data.width = set.width;
    if (set.height) data.height = set.height;
    for (const name of [...names].sort()) {
      const entry = resolveEntry(set, name);
      if (entry) data.icons[name] = entry;
    }
  }
  const missing = [...names].filter((n) => !data.icons[n]);
  if (missing.length && !V2_FALLBACKS[prefix]) {
    console.warn(`  ! ${prefix}: not found → ${missing.join(", ")}`);
  }
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
// fully-resolved icon entries, for the names the v1 sets could not supply.
function v2Rescues(wanted) {
  if (!wanted.size) return {};
  const set = sourceSet("heroicons");
  const out = {};
  if (!set) return out;
  for (const name of wanted) {
    const entry = resolveEntry(set, name);
    if (entry) out[name] = entry;
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

function main() {
  if (process.argv.includes("--check")) return check();

  const used = collectUsedIcons();
  const fetched = [];
  let total = 0;

  for (const prefix of COLLECTIONS) {
    const names = used.get(prefix);
    if (!names?.size) continue;
    console.log(`→ ${prefix}: ${names.size} icons`);
    const { data, found, missing } = takeCollection(prefix, names);
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
  const rescues = v2Rescues(rescueNames);

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

try {
  main();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
