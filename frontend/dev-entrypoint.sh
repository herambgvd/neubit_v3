#!/bin/sh
# Dev-container start-up check for the Next.js frontend. Runs BEFORE `npm run dev`.
#
# THE FAILURE THIS EXISTS FOR
# ---------------------------
# HISTORY, because the shape of this file only makes sense with it. The dev
# override used to bind-mount the host checkout over /app and keep node_modules
# and .next in named volumes NESTED INSIDE that bind. Docker Desktop kept
# re-mounting the host share over those nested volumes — at boot, after a
# Desktop restart, and even mid-run after heavy host-side writes — so the
# container silently ended up reading the HOST's darwin node_modules inside a
# musl image and writing its build output back into the host checkout. It
# surfaced as ChunkLoadError reload loops, MODULE_NOT_FOUND 500s, a stylesheet
# that was 600 bytes of `/* unparsable */` because Tailwind's oxide binary
# would not load, and repeated "native addons are not ELF" repairs that were
# really refereeing a fight between two trees.
#
# That nesting is GONE (2026-09-02). node_modules and .next now live in the
# container's own filesystem — node_modules baked by the `deps` stage from
# package-lock.json, so its binaries are musl by construction — and only the
# source paths are bind-mounted. The whole class of failure went with it.
#
# WHAT REMAINS WORTH CHECKING, and why each is still here:
#
#   * WRONG-PLATFORM OR STALE node_modules. Still possible if someone rebuilds
#     oddly or the image predates a dependency change, and it never announces
#     itself: `next dev` starts, fails to load its native half, and serves 500s.
#     The lockfile stamp and the ELF byte-check below catch both.
#   * A CORRUPT TURBOPACK CACHE. A container killed mid-write leaves a
#     half-written RocksDB in .next/cache and the next start dies on "Failed to
#     open SST file". Cheap to throw away, so the crash-retry at the bottom does.
#   * SOURCE NOT ACTUALLY MOUNTED — the new layout's own failure mode, checked
#     just below: the container would serve the image's frozen snapshot while
#     every edit appeared to do nothing.
#
# Every one of these was once diagnosed and repaired BY HAND. None announces
# what it is; that is what this script is for.
#
# It is a DEV-ONLY entrypoint. The production runner image is self-contained and
# never runs this.
set -e
cd /app

# ── SOURCE-MOUNT CHECK ───────────────────────────────────────────────────────
# The compose layout changed on 2026-09-02: /app is NO LONGER bind-mounted, and
# node_modules/.next are no longer volumes nested inside one. Only the source
# paths are bound. That removed the shadow failure this script used to guard
# against (Docker Desktop re-mounting the host share over nested volumes), so
# the old device-id guard and its runtime watchdog are gone with it — their
# invariant was "the nested volumes are attached", and there are none now.
#
# What is worth checking in the new layout is the opposite: that the SOURCE is
# actually bound. If /app/src sits on the same device as /app it came from the
# image, not the host, and the container would serve a frozen snapshot while
# every edit appeared to do nothing.
if [ "$(stat -c %d /app 2>/dev/null)" = "$(stat -c %d /app/src 2>/dev/null)" ]; then
  echo "[dev-entrypoint] WARNING: /app/src is not bind-mounted from the host —"
  echo "  this container is serving the image's snapshot and will ignore edits."
  echo "  Check the frontend service's volumes in docker-compose.override.yml."
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
