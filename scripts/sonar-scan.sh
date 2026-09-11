#!/usr/bin/env bash
#
# Analyse this repo against a SonarQube server. This is the documented way to do
# it, and — for now — the ONLY way that works.
#
#     SONAR_TOKEN=sqp_… ./scripts/sonar-scan.sh
#     SONAR_TOKEN=sqp_… SONAR_HOST_URL=http://sonar.example:9000 ./scripts/sonar-scan.sh
#
# ── WHY NOT JUST RUN IT IN CI ────────────────────────────────────────────────
#
# The snippet SonarQube's setup wizard hands you points SONAR_HOST_URL at your own
# server, and on a laptop that is http://localhost:9000. A GitHub-hosted runner has
# its own localhost; it cannot reach yours, and the job fails with a connection
# error that looks like a broken token. .github/workflows/sonar.yml is wired for
# the day that changes (a self-hosted runner, a reachable server, or SonarCloud)
# and stays switched off until then. Until that day, analysis happens here.
#
# ── WHY DOCKER ──────────────────────────────────────────────────────────────
#
# sonar-scanner is a JRE application with a per-server cache. The official image
# carries both, so nothing is installed on the machine and the scanner version is
# the one the server expects.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${SONAR_TOKEN:?set SONAR_TOKEN — generate one in SonarQube under My Account → Security}"

# From INSIDE the scanner container, the host's SonarQube is host.docker.internal.
# A default of localhost here would resolve to the container itself and fail with a
# connection refused that reads like the server being down.
DEFAULT_HOST="http://host.docker.internal:9000"
HOST_URL="${SONAR_HOST_URL:-$DEFAULT_HOST}"
case "$HOST_URL" in
  http://localhost*|http://127.0.0.1*)
    echo "==> rewriting $HOST_URL to $DEFAULT_HOST (localhost inside the scanner is the scanner)"
    HOST_URL="$DEFAULT_HOST"
    ;;
esac

echo "==> scanning $REPO_ROOT against $HOST_URL"

# The cache volume is worth keeping: without it every run re-downloads the server's
# analyser plugins, which is most of the wall-clock time of a scan.
docker run --rm \
  -e SONAR_HOST_URL="$HOST_URL" \
  -e SONAR_TOKEN="$SONAR_TOKEN" \
  -v "$REPO_ROOT:/usr/src:ro" \
  -v neubit-sonar-cache:/opt/sonar-scanner/.sonar/cache \
  --add-host=host.docker.internal:host-gateway \
  sonarsource/sonar-scanner-cli:latest \
  "$@"

echo "==> done. Findings: ${HOST_URL/host.docker.internal/localhost}/dashboard?id=neubit"
