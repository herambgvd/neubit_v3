# Neubit v3 ops-agent — privileged infra-control sidecar. Built with uv, like core.
#
# SECURITY: this is the ONLY service that mounts /var/run/docker.sock. It has no
# host port and no Traefik labels — it is reachable only on the internal `neubit`
# docker network, and every request must carry X-Ops-Token == OPS_AGENT_TOKEN.
FROM python:3.11-slim

# uv: fast Python package manager (replaces pip).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# Deps first (layer cache), then source.
COPY requirements.txt ./
RUN uv pip install --system --no-cache -r requirements.txt \
 && groupadd --system --gid 10001 neubit \
 && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin neubit

COPY main.py ./

# NON-ROOT, WITH ONE SUPPLEMENTARY GROUP — the one thing this image needs.
#
# ops-agent is the privileged infra sidecar: it holds /var/run/docker.sock and acts
# on containers on the platform's behalf. That socket is mode 0660, so reaching it
# needs its GROUP, not root — and the group differs by host (0 under Docker
# Desktop, a `docker` gid on most Linux distributions). Baking one in would work on
# the machine it was built for and fail silently everywhere else.
#
# So the image drops to uid 10001 like every other service, and the DEPLOYMENT
# supplies the group via compose's `group_add`. Group membership on one socket is a
# narrower privilege than uid 0: this process can no longer write root-owned files,
# change ownership, or install anything — it can talk to the daemon, which is the
# whole job.
USER neubit

EXPOSE 9000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
