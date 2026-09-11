#!/usr/bin/env bash
#
# Run the vision test suite.
#
#     ./backend/vision/run-tests.sh                 # everything
#     ./backend/vision/run-tests.sh tests/test_x.py # pytest args pass through
#
# Same shape as backend/ingest/run-tests.sh: a throwaway container built from the
# shipped image plus a runner, tree mounted read-only, no network.
#
# There was no runner at all until now. 44 files of tests existed and nothing
# could execute them — no CI job, and no new developer without reverse-engineering
# the image. A test that cannot be run is not a test.
#
# The kernel comes from the WORKING TREE, not the image's build-time snapshot at
# /opt/kernel, or the suite tests code that is not the code being changed. That is
# not hypothetical: two services ran a stale kernel — and a stale CORS policy —
# for a whole morning because `docker compose up -d` does not rebuild.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VISION_IMAGE="${VISION_IMAGE:-neubit-v3-vision:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-vision-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$VISION_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$VISION_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build vision" >&2
  echo "  Or point at another one:  VISION_IMAGE=... $0" >&2
  exit 1
fi

echo "==> test image: $TEST_IMAGE (from $VISION_IMAGE)" >&2
if ! "$DOCKER" build -q \
      --build-arg "VISION_IMAGE=$VISION_IMAGE" \
      -t "$TEST_IMAGE" \
      -f "$REPO/backend/vision/tests/Dockerfile.test" \
      "$REPO/backend/vision/tests" >/dev/null; then
  if "$DOCKER" image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "run-tests.sh: build failed (no network?); re-using the existing $TEST_IMAGE." >&2
  else
    echo "run-tests.sh: could not build $TEST_IMAGE and none exists." >&2
    exit 1
  fi
fi

# COVERAGE is opt-in (`--coverage`): measuring costs ~30% of the run, and the
# everyday use of this script is "did I break anything". CI and the SonarQube scan
# ask for it; a developer waiting on a red test does not. The report goes to a
# WRITABLE mount of its own, because the source tree is mounted read-only on
# purpose and that has to stay true.
COV_ARGS=()
COV_MOUNT=()
if [[ "${1:-}" == "--coverage" ]]; then
  shift
  mkdir -p "$REPO/backend/vision/coverage"
  COV_MOUNT=(-v "$REPO/backend/vision/coverage:/cov" -e COVERAGE_FILE=/cov/.coverage)
  COV_ARGS=(--cov=app --cov-report=xml:/cov/coverage.xml --cov-report=term-missing:skip-covered)
fi

run_suite() {
"$DOCKER" run --rm --network none \
  ${COV_MOUNT[@]+"${COV_MOUNT[@]}"} \
  -v "$REPO/backend/vision/app:/app/app:ro" \
  -v "$REPO/backend/vision/tests:/app/tests:ro" \
  -v "$REPO/backend/vision/pyproject.toml:/app/pyproject.toml:ro" \
  `# migrations + alembic.ini: tests/test_migrations.py runs the chain against a
   # scratch database, and it has to run the WORKING TREE's chain. Without these
   # mounts it tests the copy baked into the image, which is exactly as old as the
   # last build — a stale image made the suite pass while a fresh install was broken.` \
  -v "$REPO/backend/vision/migrations:/app/migrations:ro" \
  -v "$REPO/backend/vision/alembic.ini:/app/alembic.ini:ro" \
  -v "$REPO/backend/kernel/kernel:/opt/kernel/kernel:ro" \
  -w /app \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_ENV=dev \
  -e VE_JWT_SECRET=test-jwt-secret-that-is-long-enough-for-hs256 \
  -e VE_SECRETS_KEY=test-secrets-key \
  -e VE_DATABASE_URL=sqlite+aiosqlite:///:memory: \
  -e VE_NATS_URL= \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider ${COV_ARGS[@]+"${COV_ARGS[@]}"} "$@"
}

run_suite "$@"
status=$?

# The XML records the path coverage saw INSIDE the container. SonarQube resolves a
# report's filenames against its <source>, and that path does not exist on the
# scanner's filesystem — every file would be "not found" and the report silently
# ignored. Rewriting it repo-relative is what makes the import land.
if [[ -f "$REPO/backend/vision/coverage/coverage.xml" ]] && [[ ${#COV_ARGS[@]} -gt 0 ]]; then
  python3 - "$REPO/backend/vision/coverage/coverage.xml" <<'PYFIX'
import pathlib, re, sys
f = pathlib.Path(sys.argv[1])
f.write_text(re.sub(r"<source>.*?</source>", "<source>backend/vision/app</source>", f.read_text(), count=1))
PYFIX
  echo "==> coverage: backend/vision/coverage/coverage.xml"
fi
exit $status
