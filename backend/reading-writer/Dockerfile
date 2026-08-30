# Neubit v3 reading-writer — the IoT pipeline's writer. Built with uv.
#
# Unlike `reporting` (a migrator that runs and exits) this is a LONG-RUNNING
# service: a durable queue-group JetStream consumer plus a small HTTP surface for
# health, readiness and metrics.
#
# It installs the `reporting` package because the schema lives there and is
# imported, not redeclared (contract §7 — the writer owns the readings schema, in
# one place). It does NOT run migrations: `reporting-migrate` does that.
#
# NOTE: the build context is `backend/` so both `kernel/` and `reporting/` are
# available to COPY. See compose:
#   build: { context: ../backend, dockerfile: reading-writer/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

# The schema package. Editable so a schema change is one rebuild, not two.
COPY reporting /opt/reporting
RUN uv pip install --system --no-cache -e /opt/reporting

COPY reading-writer/pyproject.toml ./
COPY reading-writer/app ./app
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
