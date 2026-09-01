# Neubit v3 dashboards service. Built with uv.
#
# The dashboard builder's STORE: dashboards, widgets and their grid geometry in
# its own database (neubit_dashboards). It does not read the reading store — a
# widget's data comes from the reading-writer's /api/v1/bi/query, which owns that
# schema (contract §7).
#
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: dashboards/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Shared kernel first (its own layer), then the service. Both editable so the
# path dep resolves without a package index.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY dashboards/pyproject.toml ./
COPY dashboards/app ./app
COPY dashboards/migrations ./migrations
COPY dashboards/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
