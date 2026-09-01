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

# ── MOUNT-SHADOW GUARD ───────────────────────────────────────────────────────
# After a Docker Desktop restart (a reboot, an update, the machine sleeping),
# this container can come back with its named volumes SHADOWED: the config
# still lists node_modules and .next as volumes, but /proc/mounts shows only
# the /app host bind — the gRPC-FUSE share re-mounts OVER the volumes on VM
# boot. `docker restart` does NOT fix it; only a recreate re-attaches them.
#
# Running in that state is what caused every shape of this container's
# recurring breakage: .next fills with the host's mixed build (routes 404
# their own chunks), and — far worse — the repair below runs `npm ci` INTO
# THE HOST'S CHECKOUT, replacing the host's darwin binaries with musl ones.
# So: detect the shadow FIRST and refuse to start. When the volumes are
# attached, /app/.next sits on its own device (ext4) while /app is the FUSE
# share; identical device ids mean the volume is not there.
mkdir -p .next
if [ "$(stat -c %d /app)" = "$(stat -c %d /app/.next)" ]; then
  echo "════════════════════════════════════════════════════════════════════"
  echo "[dev-entrypoint] REFUSING TO START: the named volumes are SHADOWED."
  echo "  /app/.next is on the same device as /app — the frontend_next and"
  echo "  frontend_node_modules volumes did not attach (this happens after a"
  echo "  Docker Desktop restart; a plain 'restart' will NOT fix it)."
  echo "  Fix:  docker compose up -d --force-recreate frontend"
  echo "  Starting anyway would fill the HOST checkout with container output"
  echo "  and npm-ci over the host's node_modules."
  echo "════════════════════════════════════════════════════════════════════"
  exit 1
fi

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
# A .next produced by a DIFFERENT BUILDER than the one about to run.
#
# THE FAILURE THIS EXISTS FOR: the dev server starts, reports healthy, and
# serves every page 200 — but a specific route's client chunk is never emitted,
# so the browser fetches /_next/static/chunks/app/(app)/<route>/page.js, gets a
# 404, and throws ChunkLoadError. Next's error boundary then reloads, which
# fetches the same missing chunk again. The page sits in a reload loop while
# every health check and every log line says the server is fine.
#
# It happened because this volume accumulated three builders' output at once: a
# production build (BUILD_ID, standalone/, hashed static/chunks names), leftover
# Turbopack artifacts (server/chunks/[turbopack]_runtime.js), and the current
# webpack dev tree. Two routes never recompiled and nothing said so.
#
# None of the checks above catch it: node_modules is fine, and the dev server
# does not die — it is the SILENT half of this class of failure, which is why it
# gets its own check rather than being folded into the crash-retry below.
#
# Clearing .next costs one slow first compile. Leaving it costs a dev server
# that looks healthy and cannot be used.
mixed=""
if [ -f .next/BUILD_ID ] || [ -d .next/standalone ]; then
  mixed="a production build (BUILD_ID/standalone) — this is a dev container"
else
  case "$*" in
    *--webpack*)
      if [ -n "$(find .next -name '*turbopack*' -print -quit 2>/dev/null)" ]; then
        mixed="Turbopack output, but this container runs webpack"
      fi
      ;;
  esac
fi
if [ -n "$mixed" ]; then
  echo "[dev-entrypoint] CLEARING .next: it holds $mixed"
  # The directory is a volume mount point and cannot be removed ("Resource
  # busy"), so empty it rather than delete it.
  find .next -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
fi

if [ "${NEUBIT_RESET_NEXT_CACHE:-0}" = "1" ]; then
  echo "[dev-entrypoint] NEUBIT_RESET_NEXT_CACHE=1 — clearing .next"
  rm -rf .next
fi

"$@" &
child=$!
# Forward the stop signal, or `docker compose stop` waits out its whole timeout.
trap 'kill -TERM "$child" 2>/dev/null' TERM INT

# ── RUNTIME shadow watchdog ──────────────────────────────────────────────────
# The start-up check above is NOT enough: observed 2026-09-01, a container that
# booted with its volumes correctly attached had them SHADOWED while running —
# Docker Desktop re-mounted the host share over the nested volume mounts with
# no restart (RestartCount 0, entrypoint never re-ran). The dev server then
# served 500s with MODULE_NOT_FOUND on next/swc, because /app/node_modules had
# silently become the HOST's darwin tree.
#
# A degraded-but-running container is the worst outcome: health checks pass,
# the port answers, and every request fails. So watch the same device-id
# invariant while running and EXIT when it breaks — an exited container with
# the reason in its logs is honest, and the fix is one documented command.
(
  while sleep 20; do
    kill -0 "$child" 2>/dev/null || exit 0
    if [ "$(stat -c %d /app 2>/dev/null)" = "$(stat -c %d /app/.next 2>/dev/null)" ]; then
      echo "════════════════════════════════════════════════════════════════════"
      echo "[dev-entrypoint] VOLUMES WENT SHADOWED WHILE RUNNING — stopping."
      echo "  /app/.next is back on the same device as /app: Docker Desktop"
      echo "  re-mounted the host share over the named volumes mid-run. The dev"
      echo "  server would serve 500s and write container output into the HOST"
      echo "  checkout, so it is being stopped instead."
      echo "  Fix:  docker compose up -d --force-recreate frontend"
      echo "════════════════════════════════════════════════════════════════════"
      kill -TERM "$child" 2>/dev/null
      exit 0
    fi
  done
) &
watchdog=$!

started=$(date +%s)
wait "$child" || status=$?
status=${status:-0}
kill "$watchdog" 2>/dev/null
elapsed=$(( $(date +%s) - started ))

if [ "$status" -ne 0 ] && [ "$elapsed" -lt 30 ]; then
  echo "[dev-entrypoint] dev server exited ${status} after ${elapsed}s — assuming a corrupt build cache; clearing .next/cache and retrying once"
  rm -rf .next/cache
  exec "$@"
fi
exit "$status"
