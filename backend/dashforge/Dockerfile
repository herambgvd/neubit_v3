# Neubit v3 dashforge service. Built with uv.
#
# The DashForge embed REGISTRY: which DashForge dashboards this platform shows,
# in its own database (neubit_dashforge), plus the gated mint of a short-lived
# embed token. It stores no dashboard definition and runs no query — DashForge
# owns both.
#
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: dashforge/Dockerfile }
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

COPY dashforge/pyproject.toml ./
COPY dashforge/app ./app
COPY dashforge/migrations ./migrations
COPY dashforge/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
