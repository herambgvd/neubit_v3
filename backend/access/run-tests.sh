#!/usr/bin/env bash
#
# Run access's test suite.
#
#     ./backend/access/run-tests.sh                 # everything
#     ./backend/access/run-tests.sh tests/test_x.py # pytest args pass through
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

# deploy/ is mounted because one test is about the DEPLOYMENT, not the code:
# access's healthcheck has to consume /readyz. That endpoint existed nowhere and
# nothing consumed it, precisely because no test could see the compose file.
# COVERAGE is opt-in (`--coverage`): measuring costs ~30% of the run, and the
# everyday use of this script is "did I break anything". CI and the SonarQube scan
# ask for it; a developer waiting on a red test does not. The report goes to a
# WRITABLE mount of its own, because the source tree is mounted read-only on
# purpose and that has to stay true.
COV_ARGS=()
COV_MOUNT=()
if [[ "${1:-}" == "--coverage" ]]; then
  shift
  mkdir -p "$REPO/backend/access/coverage"
  COV_MOUNT=(-v "$REPO/backend/access/coverage:/cov" -e COVERAGE_FILE=/cov/.coverage)
  COV_ARGS=(--cov=app --cov-report=xml:/cov/coverage.xml --cov-report=term-missing:skip-covered)
fi

run_suite() {
"$DOCKER" run --rm --network none \
  ${COV_MOUNT[@]+"${COV_MOUNT[@]}"} \
  -v "$REPO/backend:/src:ro" \
  -v "$REPO/deploy:/repo/deploy:ro" \
  -e VE_REPO_ROOT=/repo \
  -w /src/access \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_JWT_SECRET=test-jwt-secret-that-is-long-enough-for-hs256 \
  -e VE_SECRETS_KEY=test-secrets-key \
  -e VE_DATABASE_URL=sqlite+aiosqlite:///:memory: \
  -e VE_NATS_URL= \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider ${COV_ARGS[@]+"${COV_ARGS[@]}"} "$@"
}

# `tee`, so the run still streams live AND the output survives for the block at
# the bottom. A suite that prints nothing until it finishes reads as a hang, so
# streaming is not negotiable here.
RUN_LOG="$(mktemp -t neubit-tests)"
trap 'rm -f "$RUN_LOG"' EXIT
# `set +e` around the run, because `set -e` would abort the script the moment the
# suite fails — which is the one run where the lines below matter most. It is also
# why a failing run never rewrote its coverage XML.
set +e
run_suite "$@" 2>&1 | tee "$RUN_LOG"
status=${PIPESTATUS[0]}
set -e

# The XML records the path coverage saw INSIDE the container. SonarQube resolves a
# report's filenames against its <source>, and that path does not exist on the
# scanner's filesystem — every file would be "not found" and the report silently
# ignored. Rewriting it repo-relative is what makes the import land.
if [[ -f "$REPO/backend/access/coverage/coverage.xml" ]] && [[ ${#COV_ARGS[@]} -gt 0 ]]; then
  python3 - "$REPO/backend/access/coverage/coverage.xml" <<'PYFIX'
import pathlib, re, sys
f = pathlib.Path(sys.argv[1])
f.write_text(re.sub(r"<source>.*?</source>", "<source>backend/access/app</source>", f.read_text(), count=1))
PYFIX
  echo "==> coverage: backend/access/coverage/coverage.xml"
fi

# WHICH TEST FAILED, as the LAST thing on stdout.
#
# pytest already names its failures, in a "short test summary info" block — which
# then has the rest of a coverage report printed after it. A flaky test was lost
# exactly that way: the run was watched through `| tail -1`, the summary scrolled
# past, and all that survived was "1 failed, 664 passed". Nobody could say which
# one, and it did not recur.
#
# So the names are repeated here, at the end, where truncation cannot reach them.
if [[ $status -ne 0 ]]; then
  failed="$(grep -E '^(FAILED|ERROR) ' "$RUN_LOG" || true)"
  if [[ -n "$failed" ]]; then
    echo
    echo "==> FAILED (repeated so a truncated log still names them):"
    printf '%s\n' "$failed"
  fi
fi

exit $status
