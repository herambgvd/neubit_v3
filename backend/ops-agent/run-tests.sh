#!/usr/bin/env bash
#
# Run the ops-agent test suite.
#
#     ./backend/ops-agent/run-tests.sh
#     ./backend/ops-agent/run-tests.sh tests/test_auth.py -q
#
# Throwaway container, tree mounted read-only, no network and no docker socket —
# the tests drive the app through ASGI with a fake docker client, so nothing here
# can touch a real daemon.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS_IMAGE="${OPS_IMAGE:-neubit-v3-ops-agent:latest}"
TEST_IMAGE="${TEST_IMAGE:-neubit-ops-agent-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$OPS_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$OPS_IMAGE' not found." >&2
  echo "  Build it:  cd deploy && docker compose build ops-agent" >&2
  exit 1
fi

echo "==> test image: $TEST_IMAGE (from $OPS_IMAGE)" >&2
"$DOCKER" build -q --build-arg "OPS_IMAGE=$OPS_IMAGE" -t "$TEST_IMAGE" \
  -f "$REPO/backend/ops-agent/tests/Dockerfile.test" \
  "$REPO/backend/ops-agent/tests" >/dev/null

exec "$DOCKER" run --rm --network none \
  -v "$REPO/backend/ops-agent:/src:ro" \
  -w /src \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e OPS_AGENT_TOKEN=test-ops-token \
  "$TEST_IMAGE" \
  python -m pytest -p no:cacheprovider "$@"
