#!/usr/bin/env bash
#
# Run the kernel's test suite.
#
#     ./backend/kernel/run-tests.sh                        # everything
#     ./backend/kernel/run-tests.sh tests/test_x.py -q     # pytest args pass through
#
# The kernel is a library, not a service, so there is no kernel image. The runner
# is whatever satellite test image is already built — they all carry the kernel's
# dependencies. The tree is mounted read-only with no network, and PYTHONPATH
# points at the WORKING TREE so the suite tests the code being changed rather than
# the copy baked into the image.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_IMAGE="${TEST_IMAGE:-neubit-access-tests:latest}"
DOCKER="${DOCKER:-docker}"

if ! "$DOCKER" image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
  echo "run-tests.sh: image '$TEST_IMAGE' not found." >&2
  echo "  Build one:  ./backend/access/run-tests.sh   (builds neubit-access-tests)" >&2
  echo "  Or point at another:  TEST_IMAGE=... $0" >&2
  exit 1
fi

exec "$DOCKER" run --rm --network none \
  -v "$REPO/backend:/src:ro" \
  -w /src/kernel \
  -e PYTHONPATH=/src/kernel \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e VE_JWT_SECRET=test-jwt-secret-long-enough-for-hs256-abcdef \
  -e VE_SECRETS_KEY=test-secrets-key \
  "$TEST_IMAGE" \
  python -W ignore -m pytest -p no:cacheprovider "$@"
