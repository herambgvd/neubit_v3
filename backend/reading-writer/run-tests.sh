#!/usr/bin/env bash
#
# Run the reading-writer test suite.
#
#     ./backend/reading-writer/run-tests.sh                 # everything
#     ./backend/reading-writer/run-tests.sh tests/test_x.py # pytest args pass through
#
# Same shape as backend/ingest/run-tests.sh: a throwaway container built from the
# shipped image plus a test runner, tree mounted read-only, no network.
#
# The `reporting` package is mounted over the image's copy, MIGRATIONS INCLUDED —
# tests/test_schema_completeness.py reads the revision files to check that every
# table a migration creates has a model, and mounting only the python package
# would leave it reading the image's build-time snapshot.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RW_IMAGE="${RW_IMAGE:-neubit-v3-reading-writer:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-reading-writer-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$RW_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$RW_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build reading-writer" >&2
  echo "  Or point at another one:  RW_IMAGE=... $0" >&2
  exit 1
fi

echo "==> test image: $TEST_IMAGE (from $RW_IMAGE)" >&2
if ! "$DOCKER" build -q \
      --build-arg "READING_WRITER_IMAGE=$RW_IMAGE" \
      -t "$TEST_IMAGE" \
      -f "$REPO/backend/reading-writer/tests/Dockerfile.test" \
      "$REPO/backend/reading-writer/tests" >/dev/null; then
  if "$DOCKER" image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "run-tests.sh: build failed (no network?); re-using the existing $TEST_IMAGE." >&2
  else
    echo "run-tests.sh: could not build $TEST_IMAGE and none exists." >&2
    exit 1
  fi
fi

# The database URL is never connected to — every test here is pure — but kernel
# settings refuse to load without one.
exec "$DOCKER" run --rm --network none \
  -v "$REPO/backend/reading-writer/app:/app/app:ro" \
  -v "$REPO/backend/reading-writer/tests:/app/tests:ro" \
  -v "$REPO/backend/reporting/reporting:/opt/reporting/reporting:ro" \
  -v "$REPO/backend/reporting/migrations:/opt/reporting/migrations:ro" \
  -v "$REPO/backend/kernel/kernel:/opt/kernel/kernel:ro" \
  -w /app \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_ENV=dev \
  -e VE_JWT_SECRET=test-jwt-secret-that-is-long-enough-for-hs256 \
  -e VE_SECRETS_KEY=test-secrets-key \
  -e VE_DATABASE_URL=postgresql+asyncpg://localhost:5432/neubit_reporting \
  -e VE_NATS_URL= \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider "$@"
