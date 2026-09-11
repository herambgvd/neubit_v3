# Neubit v3 access-control (gates) service. Built with uv.
# NOTE: the build context is `backend/` (the parent dir) so the shared kernel
# `kernel/` is available to COPY alongside this service. See compose:
#   build: { context: ../backend, dockerfile: access/Dockerfile }
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 neubit \
 && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin neubit

# Shared kernel first (its own layer), then the service. Install both editable so
# the path dep resolves without a package index.
COPY kernel /opt/kernel
RUN uv pip install --system --no-cache -e /opt/kernel

COPY access/pyproject.toml ./
COPY access/app ./app
COPY access/migrations ./migrations
COPY access/alembic.ini ./
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

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
