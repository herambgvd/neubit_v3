#!/bin/sh
# Dev-container start-up check for the Next.js frontend. Runs BEFORE `npm run dev`.
#
# THE FAILURE THIS EXISTS FOR
# ---------------------------
# The dev override bind-mounts the host checkout over /app and keeps
# node_modules and .next in volumes so the container's own copies survive. That
# arrangement broke four times in one day, in two shapes:
#
#   * WRONG-PLATFORM BINARIES. npm installs native packages per platform. A
#     macOS host has @next/swc-darwin-arm64 and @tailwindcss/oxide-darwin-arm64;
#     an alpine container needs the -linux-*-musl builds. When the volume ends up
#     holding the host's tree, `next dev` starts, fails to load its native half,
#     and serves 500s — or, worse, serves a stylesheet that is 600 bytes of
#     `/* unparsable */` because Tailwind's oxide binary is missing but the dev
#     server carries on regardless.
#   * A STALE VOLUME. A volume is seeded from the image ONCE, on creation, and
#     never again. So `docker compose build frontend` after adding a dependency
#     changes nothing the running container can see: the new package is simply
#     absent, and the error is a module-not-found from a file that plainly exists
#     in package.json.
#   * A CORRUPT TURBOPACK CACHE. A container killed mid-write leaves a half-written
#     RocksDB in .next/cache, and the next start dies on "Failed to open SST file".
#
# Every one of those was diagnosed and repaired BY HAND. None of them announces
# what it is. This script makes the container check its own tree at start-up and
# repair it, so the failure mode is a slow first boot with a clear log line
# instead of a mystery 500.
#
# It is a DEV-ONLY entrypoint. The production runner image is self-contained and
# never runs this.
set -e
cd /app

STAMP=node_modules/.neubit-install-stamp
reason=""

if [ ! -d node_modules ] || [ ! -d node_modules/next ]; then
  reason="node_modules is missing"
elif [ "$(cat "$STAMP" 2>/dev/null)" != "$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)" ]; then
  # The lockfile that produced this tree is not the lockfile on disk. Either a
  # dependency was added since the volume was seeded, or the tree came from
  # somewhere other than an install of this lockfile.
  reason="node_modules was installed from a different package-lock.json"
elif [ -n "$(find node_modules -name '*.node' -type f -exec sh -c '
    # Every compiled addon in a Linux container MUST be an ELF. A Mach-O (a macOS
    # host tree that ended up in this volume) starts 0xCF 0xFA 0xED 0xFE; a
    # truncated or empty one starts with nothing at all. This is the check that
    # catches the actual symptom — a dev server that starts, fails to load its
    # native half, and serves 500s or a 600-byte `/* unparsable */` stylesheet.
    # It is deliberately a byte check and not a require(): several of these
    # packages fall back to a WASM or JS implementation when the addon will not
    # load, so require() SUCCEEDS while the thing you need is broken.
    head -c 4 "$1" | od -An -tx1 | tr -d " \n" | grep -qx "7f454c46" || echo "$1"
  ' _ {} \; 2>/dev/null)" ]; then
  reason="native addons are not ELF binaries (a macOS tree in a Linux container, or a truncated install)"
elif ! node -e 'require("next")' >/dev/null 2>&1; then
  reason="next itself does not load"
fi

if [ -n "$reason" ]; then
  echo "[dev-entrypoint] REPAIRING node_modules: $reason"
  # A partly-foreign tree cannot be patched by an `npm install` on top of it —
  # npm keeps what is already there. Start clean. The DIRECTORY itself is a
  # volume mount point and cannot be removed ("Resource busy"), so empty it
  # rather than delete it.
  find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  npm ci --legacy-peer-deps || npm install --legacy-peer-deps
  sha256sum package-lock.json | cut -d' ' -f1 > "$STAMP"
  # A build cache produced against the old tree is not trustworthy against the
  # new one, and a corrupt one is exactly the "Failed to open SST file" crash.
  rm -rf .next/cache
  echo "[dev-entrypoint] node_modules repaired"
else
  echo "[dev-entrypoint] node_modules OK (lockfile matches, native binaries load)"
fi

# Turbopack's RocksDB build cache survives a container kill in a half-written
# state and then refuses to open ("Failed to open SST file"), taking the dev
# server down on every subsequent start. It cannot be detected before the fact —
# so instead: start the server, and if it dies almost immediately, throw the
# cache away and start it once more. A cache is by definition disposable; the
# cost of being wrong is one slow compile, and the cost of not doing it is a dev
# server that is dead until somebody remembers this failure mode.
if [ "${NEUBIT_RESET_NEXT_CACHE:-0}" = "1" ]; then
  echo "[dev-entrypoint] NEUBIT_RESET_NEXT_CACHE=1 — clearing .next"
  rm -rf .next
fi

"$@" &
child=$!
# Forward the stop signal, or `docker compose stop` waits out its whole timeout.
trap 'kill -TERM "$child" 2>/dev/null' TERM INT

started=$(date +%s)
wait "$child" || status=$?
status=${status:-0}
elapsed=$(( $(date +%s) - started ))

if [ "$status" -ne 0 ] && [ "$elapsed" -lt 30 ]; then
  echo "[dev-entrypoint] dev server exited ${status} after ${elapsed}s — assuming a corrupt build cache; clearing .next/cache and retrying once"
  rm -rf .next/cache
  exec "$@"
fi
exit "$status"
