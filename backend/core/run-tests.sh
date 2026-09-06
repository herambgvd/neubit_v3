#!/usr/bin/env bash
#
# Run core's test suite. This is the documented, reproducible way to do it.
#
#     ./backend/core/run-tests.sh              # the whole suite
#     ./backend/core/run-tests.sh -v           # any pytest args pass through
#     ./backend/core/run-tests.sh tests/test_tenant_isolation.py
#
# ── WHY A SCRIPT AND NOT "pytest" ────────────────────────────────────────────
#
#   1. The suite cannot run on the host as-is: it needs core's whole dependency
#      set (fastapi, pydantic-settings, sqlalchemy, argon2, pyjwt …) and there is
#      no install step for them. The core image has all of them, so the image is
#      the environment.
#
#   2. It needs the shared kernel, which core's image deliberately does not have.
#      tests/test_token_role_id.py asserts a two-sided contract: core mints the
#      `role_id` claim, `kernel` reads it back. Core is the identity provider and
#      the kernel is the SDK the satellites embed, so adding it to core's image
#      would invert that and put an unused package in a production artifact.
#
# So the image supplies the dependencies, the working tree supplies the app code,
# the tests and the kernel (VE_KERNEL_PATH below points at it). Nothing is copied
# into a running container and nothing is installed into one.
#
# ── WHY A THROWAWAY CONTAINER AND NOT `compose exec core` ────────────────────
#
# Copying the tests into the live core container and pip-installing pytest there
# mutates a running service, and worse, it passes for the wrong reason: whatever
# was hand-copied in is present, so the run only proves the suite works in an
# environment built by hand and then taken away. A container built from a
# committed Dockerfile starts from the same two inputs every time — the core image
# and this repo — so a pass is a pass from a clean state on anyone's machine.
#
# The source is mounted read-only with bytecode and cache writing off, so a run
# cannot modify the working tree. --network none because these tests reach
# nothing; if one ever needs the network, discover that here rather than in CI.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE_IMAGE="${CORE_IMAGE:-neubit-v3-core:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-core-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$CORE_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$CORE_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build core" >&2
  echo "  Or point at another one:  CORE_IMAGE=... $0" >&2
  exit 1
fi

# Build (or re-use) the test image: the core image + a test runner. Cached, so it
# is a no-op until requirements-test.txt changes. Needs the network once; the test
# run itself never does.
echo "==> test image: $TEST_IMAGE (from $CORE_IMAGE)" >&2
if ! "$DOCKER" build -q \
      --build-arg "CORE_IMAGE=$CORE_IMAGE" \
      -t "$TEST_IMAGE" \
      -f "$REPO/backend/core/tests/Dockerfile.test" \
      "$REPO/backend/core/tests" >/dev/null; then
  if "$DOCKER" image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    # Offline, but a previous build is on disk. Say so rather than silently
    # testing against a stale runner.
    echo "run-tests.sh: build failed (no network?); re-using the existing" >&2
    echo "              $TEST_IMAGE. It may predate requirements-test.txt." >&2
  else
    echo "run-tests.sh: could not build $TEST_IMAGE and none exists." >&2
    echo "              The first build needs network access to install pytest." >&2
    exit 1
  fi
fi

# `gateway/` and `deploy/` are mounted because two assertions are about the
# deployment rather than the code: tests/test_health_probes.py checks that the
# gateway routes /ready and that core's healthcheck consumes it. Read-only, and
# separate from /src so nothing on the import path changes.
exec "$DOCKER" run --rm --network none \
  -v "$REPO/backend:/src:ro" \
  -v "$REPO/gateway:/repo/gateway:ro" \
  -v "$REPO/deploy:/repo/deploy:ro" \
  -w /src/core \
  -e VE_KERNEL_PATH=/src/kernel \
  -e VE_REPO_ROOT=/repo \
  -e PYTHONDONTWRITEBYTECODE=1 \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider "$@"
