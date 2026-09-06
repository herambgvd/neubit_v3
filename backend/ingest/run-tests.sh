#!/usr/bin/env bash
#
# Run ingest test suite.
#
#     ./backend/ingest/run-tests.sh                 # everything
#     ./backend/ingest/run-tests.sh tests/test_x.py # pytest args pass through
#
# Same shape as backend/core/run-tests.sh: a throwaway container from the shipped
# image plus a test runner. Two differences — this image already carries the
# kernel at /opt/kernel, and the whole of backend/ is mounted so a test can read a
# sibling service.
#
# Mounted read-only, no network: a test that needs either would pass for the wrong
# reason on CI.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_IMAGE="${INGEST_IMAGE:-neubit-v3-ingest:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-ingest-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$INGEST_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$INGEST_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build ingest" >&2
  echo "  Or point at another one:  INGEST_IMAGE=... $0" >&2
  exit 1
fi

echo "==> test image: $TEST_IMAGE (from $INGEST_IMAGE)" >&2
if ! "$DOCKER" build -q \
      --build-arg "INGEST_IMAGE=$INGEST_IMAGE" \
      -t "$TEST_IMAGE" \
      -f "$REPO/backend/ingest/tests/Dockerfile.test" \
      "$REPO/backend/ingest/tests" >/dev/null; then
  if "$DOCKER" image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "run-tests.sh: build failed (no network?); re-using the existing $TEST_IMAGE." >&2
  else
    echo "run-tests.sh: could not build $TEST_IMAGE and none exists." >&2
    exit 1
  fi
fi

# deploy/ is mounted because one test is about the DEPLOYMENT, not the code:
# access's healthcheck has to consume /readyz. That endpoint existed nowhere and
# nothing consumed it, precisely because no test could see the compose file.
exec "$DOCKER" run --rm --network none \
  -v "$REPO/backend:/src:ro" \
  -v "$REPO/deploy:/repo/deploy:ro" \
  -e VE_REPO_ROOT=/repo \
  -w /src/ingest \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_JWT_SECRET=test-jwt-secret-that-is-long-enough-for-hs256 \
  -e VE_SECRETS_KEY=test-secrets-key \
  -e VE_DATABASE_URL=sqlite+aiosqlite:///:memory: \
  -e VE_NATS_URL= \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider "$@"
