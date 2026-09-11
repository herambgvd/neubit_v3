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
RUN uv pip install --system --no-cache -r requirements.txt

COPY main.py ./

# THIS ONE STAYS ROOT, and that is the whole reason it exists as a separate image.
#
# ops-agent is the privileged infra sidecar: it holds /var/run/docker.sock and acts
# on containers on the platform's behalf. Reaching that socket needs either root or
# membership of the host's docker group — whose gid differs per host, so baking one
# in would work on the machine it was built for and silently fail everywhere else.
#
# The containment is that this is the ONLY image with the socket and the only one
# without a USER, which is why every other service was moved off root rather than
# this being treated as normal.

EXPOSE 9000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
