# Neubit v3 reporting-projector — domain events on the bus become reporting rows.
#
# A LONG-RUNNING service: one durable pull consumer per row of
# `neubit_reporting.reporting_projections`, plus a small HTTP surface for health,
# readiness and metrics.
#
# It installs the `reporting` package for the store's engine/session factory. It
# does NOT run migrations — `reporting-migrate` owns `reporting_projections` and
# the IoT schema. It DOES create the relations a projection declares, because
# those are declared as data and no migration can know them (see app/ensure.py).
#
# NOTE: the build context is `backend/` so both `kernel/` and `reporting/` are
# available to COPY. See compose:
#   build: { context: ../backend, dockerfile: projector/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY reporting /opt/reporting
RUN uv pip install --system --no-cache -e /opt/reporting

COPY projector/pyproject.toml ./
COPY projector/app ./app
RUN uv pip install --system --no-cache -e "."

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
