#!/usr/bin/env bash
#
# Run access's test suite. The documented, reproducible way to do it.
#
#     ./backend/access/run-tests.sh                 # the whole suite
#     ./backend/access/run-tests.sh -q -p no:warnings
#     ./backend/access/run-tests.sh tests/test_tenant_isolation.py
#
# Same shape as backend/core/run-tests.sh, and for the same reasons — read that
# file's header. The two differences: this image already CARRIES the kernel at
# /opt/kernel (every satellite does; core deliberately does not), and the working
# tree is mounted over the whole of backend/ so a test can also read the sibling
# services' source where an invariant spans them.
#
# The tree is mounted READ-ONLY and the container has NO network. A test that
# needs either is a test that would pass for the wrong reason on a CI runner.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACCESS_IMAGE="${ACCESS_IMAGE:-neubit-v3-access:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-access-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$ACCESS_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$ACCESS_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build access" >&2
  echo "  Or point at another one:  ACCESS_IMAGE=... $0" >&2
  exit 1
fi

echo "==> test image: $TEST_IMAGE (from $ACCESS_IMAGE)" >&2
if ! "$DOCKER" build -q \
      --build-arg "ACCESS_IMAGE=$ACCESS_IMAGE" \
      -t "$TEST_IMAGE" \
      -f "$REPO/backend/access/tests/Dockerfile.test" \
      "$REPO/backend/access/tests" >/dev/null; then
  if "$DOCKER" image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "run-tests.sh: build failed (no network?); re-using the existing $TEST_IMAGE." >&2
  else
    echo "run-tests.sh: could not build $TEST_IMAGE and none exists." >&2
    exit 1
  fi
fi

exec "$DOCKER" run --rm --network none \
  -v "$REPO/backend:/src:ro" \
  -w /src/access \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_JWT_SECRET=test-jwt-secret-that-is-long-enough-for-hs256 \
  -e VE_SECRETS_KEY=test-secrets-key \
  -e VE_DATABASE_URL=sqlite+aiosqlite:///:memory: \
  -e VE_NATS_URL= \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider "$@"
