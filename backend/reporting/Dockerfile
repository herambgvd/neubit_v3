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
RUN uv pip install --system --no-cache -e /opt/kernel \
 && groupadd --system --gid 10001 neubit \
 && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin neubit

COPY reporting/pyproject.toml ./
COPY reporting/reporting ./reporting
COPY reporting/migrations ./migrations
COPY reporting/alembic.ini ./
RUN uv pip install --system --no-cache -e "."

# RUN AS A NON-ROOT USER from here on.
#
# Everything above needs root: apt, uv installing into the system interpreter,
# chmod on the entrypoint. Nothing below does. Left as root, an RCE in the app — or
# a container escape — starts as uid 0, and on a bind mount that is uid 0 on the
# HOST.
#
# The account is created in the OS-setup layer at the top rather than here, so this
# file has one RUN per concern instead of a second one that only adds a user. 10001
# is fixed rather than left to useradd: one uid across the estate is easier to
# reason about than seven, and it is the uid the volumes are chowned to.
USER neubit

CMD ["bash", "-c", "python -m reporting.ensure_db && alembic upgrade head && python -m reporting.apply"]
