#!/usr/bin/env bash
#
# Run the workflow test suite.
#
#     ./backend/workflow/run-tests.sh                 # everything
#     ./backend/workflow/run-tests.sh tests/test_x.py # pytest args pass through
#
# Same shape as backend/ingest/run-tests.sh: a throwaway container built from the
# shipped image plus a test runner, tree mounted read-only, no network.
#
# The kernel comes from the WORKING TREE, not the image's build-time snapshot at
# /opt/kernel — otherwise the suite tests code that is not the code being changed.
#
# ── --pg ────────────────────────────────────────────────────────────────────
# Four tests SKIP without a real Postgres, and they are the ones that need it
# most: the notification outbox claim is `SELECT ... FOR UPDATE SKIP LOCKED`, and
# SQLite has no row locks, so it would pass against broken code. Skipping them
# everywhere means the concurrency guarantee was never actually checked.
#
#     ./backend/workflow/run-tests.sh --pg
#
# joins the compose network and points VE_DATABASE_URL at neubit_workflow. Each
# test builds its own throwaway SCHEMA and drops it on the way out, so it does not
# touch the service's tables. Everything else runs identically.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW_IMAGE="${WORKFLOW_IMAGE:-neubit-v3-workflow:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-workflow-tests:latest}"
DOCKER="${DOCKER:-docker}"

# --pg: run against the real Postgres instead of offline.
NETWORK="none"
DB_URL="sqlite+aiosqlite:///:memory:"
if [ "${1:-}" = "--pg" ]; then
  shift
  NETWORK="${WORKFLOW_TEST_NETWORK:-neubit}"
  ENVFILE="$REPO/deploy/.env"
  PGUSER="${POSTGRES_USER:-$( [ -f "$ENVFILE" ] && sed -n 's/^POSTGRES_USER=//p' "$ENVFILE" | head -1 )}"
  PGPASS="${POSTGRES_PASSWORD:-$( [ -f "$ENVFILE" ] && sed -n 's/^POSTGRES_PASSWORD=//p' "$ENVFILE" | head -1 )}"
  if [ -z "${PGUSER}" ] || [ -z "${PGPASS}" ]; then
    echo "run-tests.sh --pg: no POSTGRES_USER/POSTGRES_PASSWORD (env or deploy/.env)." >&2
    exit 1
  fi
  DB_URL="postgresql+asyncpg://${PGUSER}:${PGPASS}@postgres:5432/neubit_workflow"
  echo "==> --pg: $NETWORK / neubit_workflow (throwaway schema per test)" >&2
fi

if ! "$DOCKER" image inspect "$WORKFLOW_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$WORKFLOW_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build workflow" >&2
  echo "  Or point at another one:  WORKFLOW_IMAGE=... $0" >&2
  exit 1
fi

echo "==> test image: $TEST_IMAGE (from $WORKFLOW_IMAGE)" >&2
if ! "$DOCKER" build -q \
      --build-arg "WORKFLOW_IMAGE=$WORKFLOW_IMAGE" \
      -t "$TEST_IMAGE" \
      -f "$REPO/backend/workflow/tests/Dockerfile.test" \
      "$REPO/backend/workflow/tests" >/dev/null; then
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
  mkdir -p "$REPO/backend/workflow/coverage"
  COV_MOUNT=(-v "$REPO/backend/workflow/coverage:/cov" -e COVERAGE_FILE=/cov/.coverage)
  COV_ARGS=(--cov=app --cov-report=xml:/cov/coverage.xml --cov-report=term-missing:skip-covered)
fi

run_suite() {
"$DOCKER" run --rm --network "$NETWORK" \
  ${COV_MOUNT[@]+"${COV_MOUNT[@]}"} \
  -v "$REPO/backend/workflow/app:/app/app:ro" \
  -v "$REPO/backend/workflow/tests:/app/tests:ro" \
  -v "$REPO/backend/kernel/kernel:/opt/kernel/kernel:ro" \
  -w /app \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_ENV=dev \
  -e VE_JWT_SECRET=test-jwt-secret-that-is-long-enough-for-hs256 \
  -e VE_SECRETS_KEY=test-secrets-key \
  -e VE_DATABASE_URL="$DB_URL" \
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
if [[ -f "$REPO/backend/workflow/coverage/coverage.xml" ]] && [[ ${#COV_ARGS[@]} -gt 0 ]]; then
  python3 - "$REPO/backend/workflow/coverage/coverage.xml" <<'PYFIX'
import pathlib, re, sys
f = pathlib.Path(sys.argv[1])
f.write_text(re.sub(r"<source>.*?</source>", "<source>backend/workflow/app</source>", f.read_text(), count=1))
PYFIX
  echo "==> coverage: backend/workflow/coverage/coverage.xml"
fi
exit $status
