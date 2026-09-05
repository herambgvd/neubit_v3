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
# Two facts about this suite, both of which cost a reviewer an afternoon before
# this file existed:
#
#   1. IT CANNOT RUN ON THE HOST as-is. It needs fastapi, pydantic-settings,
#      sqlalchemy, argon2, pyjwt and a dozen more — core's whole dependency set —
#      and there has never been a documented install step for them. The core
#      IMAGE already has every one of them, so the image is the environment.
#
#   2. IT NEEDS THE SHARED KERNEL, which core's image deliberately does NOT have.
#      tests/test_token_role_id.py asserts a two-sided contract: core mints the
#      `role_id` claim, `kernel` reads it back. Core is the identity provider and
#      the kernel is the SDK the satellites embed — every satellite Dockerfile
#      does `COPY kernel /opt/kernel`, core's does not, and core's build context
#      is backend/core so the package is not even reachable at build time. Adding
#      it to the image to make one test import would invert that relationship and
#      put an unused package in a production artifact.
#
# So: the image supplies the dependencies, the WORKING TREE supplies both the app
# code and the tests, and the kernel is simply the directory sitting next to core
# in that same tree (tests/conftest.py looks there; VE_KERNEL_PATH below makes it
# explicit rather than implied). Nothing is copied into a running container and
# nothing is installed into one.
#
# ── WHY A THROWAWAY CONTAINER AND NOT `compose exec core` ────────────────────
#
# The original harness for this suite was "copy the tests into the live core
# container, pip install pytest there, run". That mutates a running service to
# test it and leaves a test runner installed in it. But the reason it actually
# mattered is subtler: it PASSES FOR THE WRONG REASON. Whatever you hand-copied
# in is present, so the run proves the suite works in an environment you built by
# hand and then took away. That is exactly how a broken import survived being
# "verified" — the kernel was copied in for the run and deleted after it, and the
# suite went back to collecting zero tests the moment nobody was looking.
#
# A throwaway container built from a committed Dockerfile cannot do that. It
# starts from the same two inputs every time — the core image and this repo — so
# a pass here is a pass from a clean state, on anyone's machine.
#
# The source is mounted READ-ONLY with bytecode and cache writing off, so a test
# run cannot modify the working tree. --network none because these tests reach
# nothing; if one ever needs the network that is a fact worth discovering here
# rather than in CI.
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

# Build (or re-use) the test image: the core image + a test runner. Cached, so
# this is a no-op after the first run and whenever requirements-test.txt is
# unchanged. Needs the network ONCE; the test run itself never does.
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

# `gateway/` and `deploy/` are mounted because two assertions in the suite are ABOUT
# the deployment, not about the code: tests/test_health_probes.py checks that the
# gateway routes /ready and that core's healthcheck consumes it. `/ready` was
# written, correct, and reachable by nothing for months precisely because no test
# could see those files. Read-only, and separate from /src so nothing on the import
# path changes.
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
