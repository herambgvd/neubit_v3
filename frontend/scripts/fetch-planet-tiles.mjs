// Builds the offline planet basemap: a zoom-limited PMTiles extract of the
// Protomaps OpenStreetMap planet archive.
//
// The full planet (z0–15) is ~137 GB, which nobody wants on a recorder appliance.
// `pmtiles extract` pulls only the zoom levels asked for, over HTTP range
// requests, so a z0–10 world costs 3.7 GB and a handful of requests. MapLibre
// overzooms past the archive's max zoom, so you can still zoom in past z10 — the
// geometry just stops gaining detail. For a site-pin overview map that is fine.
//
//   maxzoom │  size  │ what you can read
//   ────────┼────────┼──────────────────────────────────────────
//      8    │ 543 MB │ countries, major cities
//     10    │ 3.7 GB │ cities, town names, motorways   ← default
//     12    │  17 GB │ suburbs, main street network
//     15    │ 137 GB │ individual buildings (full archive)
//
// Usage (needs network, run once on a build machine):
//   node scripts/fetch-planet-tiles.mjs
//   node scripts/fetch-planet-tiles.mjs --maxzoom=12
//   node scripts/fetch-planet-tiles.mjs --dry-run          size estimate only
//   node scripts/fetch-planet-tiles.mjs --out=/mnt/tiles/planet.pmtiles
//
// The output is a DEPLOYMENT ARTEFACT, not a repo file — deploy/tiles/ is
// gitignored and mounted into the `tiles` service (see deploy/docker-compose.yml).
// Copy the .pmtiles to the air-gapped host by whatever means you move images.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");

// Source Cooperative's permanent mirror. build.protomaps.com also serves daily
// planet builds but keeps only ~a week of them, so it is no good as a default.
const SOURCE = process.env.PLANET_PMTILES || "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";

const CLI_VERSION = process.env.PMTILES_VERSION || "1.31.2";
const CLI_DIR = path.join(REPO, "deploy/tiles/.bin");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// Release asset naming differs per OS: Darwin/Windows ship .zip with an
// underscore-or-dash quirk, Linux ships .tar.gz.
function releaseAsset() {
  const arch = os.arch() === "arm64" ? "arm64" : "x86_64";
  switch (os.platform()) {
    case "win32":
      return { file: `go-pmtiles_${CLI_VERSION}_Windows_${arch}.zip`, bin: "pmtiles.exe" };
    case "darwin":
      return { file: `go-pmtiles-${CLI_VERSION}_Darwin_${arch}.zip`, bin: "pmtiles" };
    default:
      return { file: `go-pmtiles_${CLI_VERSION}_Linux_${arch}.tar.gz`, bin: "pmtiles" };
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`)),
    );
  });
}

// Unpack a release archive into CLI_DIR. Every call runs with cwd set and a bare
// filename — a Windows absolute path like `D:\…` handed to `tar -C` parses as a
// host:path remote spec and dies with "Cannot connect to D:".
async function unpack(file) {
  if (file.endsWith(".tar.gz")) return run("tar", ["-xzf", file], { cwd: CLI_DIR });
  if (os.platform() === "win32") {
    // Not `tar`: the tar on PATH under Git Bash is GNU tar, which cannot read
    // zip. PowerShell's Expand-Archive is always there on a Windows box.
    return run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${file}' -DestinationPath . -Force`],
      { cwd: CLI_DIR },
    );
  }
  return run("unzip", ["-o", "-q", file], { cwd: CLI_DIR });
}

// Resolve the pmtiles CLI: an explicit override, else a cached download. We do
// NOT look on PATH — a stale global build silently changing the archive format
// is a worse failure than one extra 10 MB download.
async function ensureCli() {
  if (process.env.PMTILES_BIN) return process.env.PMTILES_BIN;

  const { file, bin } = releaseAsset();
  const target = path.join(CLI_DIR, bin);
  if (fs.existsSync(target)) return target;

  const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${CLI_VERSION}/${file}`;
  console.log(`↓ pmtiles CLI ${CLI_VERSION} — ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the pmtiles CLI`);
  const archive = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(CLI_DIR, { recursive: true });
  const archivePath = path.join(CLI_DIR, file);
  fs.writeFileSync(archivePath, archive);

  await unpack(file);
  fs.rmSync(archivePath, { force: true });

  if (!fs.existsSync(target)) throw new Error(`extracted archive has no ${bin}`);
  if (os.platform() !== "win32") fs.chmodSync(target, 0o755);
  return target;
}

async function main() {
  const maxzoom = arg("maxzoom", "10");
  const out = path.resolve(arg("out", path.join(REPO, "deploy/tiles/planet.pmtiles")));
  const dryRun = process.argv.includes("--dry-run");

  if (!/^\d+$/.test(maxzoom) || +maxzoom > 15) {
    throw new Error(`--maxzoom must be 0–15 (the source archive stops at 15), got "${maxzoom}"`);
  }
  if (fs.existsSync(out) && !dryRun) {
    throw new Error(`${out} already exists — delete it first, or pass --out=<other path>`);
  }

  const cli = await ensureCli();
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`\n→ extracting z0–${maxzoom} of the planet`);
  console.log(`  from ${SOURCE}`);
  console.log(`  to   ${out}${dryRun ? "  (dry run — nothing is written)" : ""}\n`);

  const args = ["extract", SOURCE, out, `--maxzoom=${maxzoom}`];
  if (dryRun) args.push("--dry-run");
  await run(cli, args);

  if (!dryRun) {
    const gb = (fs.statSync(out).size / 1024 ** 3).toFixed(2);
    console.log(`\n✓ ${path.relative(REPO, out)} — ${gb} GB`);
    console.log("  Mount it at /data/planet.pmtiles in the `tiles` service (deploy/docker-compose.yml).");
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
