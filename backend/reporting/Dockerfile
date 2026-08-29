# Neubit v3 reporting store — schema owner for neubit_reporting. Built with uv.
#
# This image is a MIGRATOR, not a server: it runs to completion (ensure the DB
# exists → alembic upgrade head → reconcile the Timescale policies) and exits.
# The long-running reading-writer that fills the schema is a separate service and
# imports `reporting.models` from this package.
#
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: reporting/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# Shared kernel first (its own layer), then the service. Install both editable so
# the path dep resolves without a package index.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY reporting/pyproject.toml ./
COPY reporting/reporting ./reporting
COPY reporting/migrations ./migrations
COPY reporting/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

CMD ["bash", "-c", "python -m reporting.ensure_db && alembic upgrade head && python -m reporting.apply"]
