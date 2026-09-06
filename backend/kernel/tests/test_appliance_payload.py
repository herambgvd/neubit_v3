"""Everything docker-compose.yml bind-mounts is in the appliance payload.

The appliance is one WSL2 distro tarball staged by
`deploy/windows/build-appliance.ps1`, and the staging is a hand-written list of
`cp` lines. The compose file it ships is the SAME one this repository develops
against, so a bind mount added here and not added there is a path that does not
exist on an installed appliance.

Docker's behaviour when a bind source is missing is the whole problem: it CREATES
IT AS A DIRECTORY. The container then fails on a config file that is a folder, the
boot log says a container restarted, and nothing anywhere says which file. That
failure has already happened once — `build-appliance.ps1` carries a long note
about the gateway, staged one level in, where Traefik exited and took :80 with it.

It happened again, and this test is why it will not a third time: enabling
authentication on the event bus added `./nats/nats.conf` as a mount and the
payload copied `postgres/` and `gateway/` and not `nats/`. Every install would
have come up with no broker.
"""

from __future__ import annotations

import os
import pathlib
import re

import pytest


def _repo() -> pathlib.Path:
    root = pathlib.Path(os.environ.get("VE_REPO_ROOT", "/repo"))
    if (root / "deploy" / "docker-compose.yml").is_file():
        return root
    return pathlib.Path(__file__).resolve().parents[3]


REPO = _repo()
COMPOSE = REPO / "deploy" / "docker-compose.yml"
BUILD = REPO / "deploy" / "windows" / "build-appliance.ps1"

pytestmark = pytest.mark.skipif(
    not COMPOSE.is_file() or not BUILD.is_file(),
    reason="deploy/ is not mounted into this suite",
)

#: Bind sources the appliance legitimately does not carry, and why.
NOT_IN_THE_PAYLOAD = {
    # The offline basemap is 3.7 GB and shipped separately; build-appliance.ps1
    # says so at the end of its own run.
    "./tiles": "3.7 GB basemap, shipped separately",
    "./tiles-server": "serves the basemap above",
    # Dev-only: the appliance runs docker-compose.yml alone, and these are the
    # source bind-mounts the override adds for hot reload.
    "../backend": "source mount, dev only",
    "../frontend": "source mount, dev only",
}


def _relative_bind_sources() -> set[str]:
    """Every `- ./x` or `- ../x` bind source in the compose file.

    Read as text rather than through a YAML parser so the test needs no
    dependency and no `docker compose config` — it is looking for a path, and a
    path is what is written.
    """
    found = set()
    for line in COMPOSE.read_text().splitlines():
        m = re.match(r"\s*-\s+(\.{1,2}/[^:]+):", line)
        if m:
            found.add(m.group(1).strip())
    return found


def _staged_paths() -> list[str]:
    """Only the `cp` lines. Matching anywhere in the file would let a COMMENT
    mentioning the path satisfy the check — which is exactly what the first
    version of this test did, so it passed while the payload was missing nats/."""
    return [
        line.strip()
        for line in BUILD.read_text().splitlines()
        if line.strip().startswith("cp ") or line.strip().startswith("cp -r ")
    ]


def test_the_compose_file_actually_has_bind_mounts():
    """A regex that matches nothing would make the assertion below vacuous."""
    assert len(_relative_bind_sources()) >= 3, _relative_bind_sources()


def test_the_staging_lines_were_found():
    """Same reason: if `cp` lines stop being recognisable, every check below
    passes over an empty list."""
    assert len(_staged_paths()) >= 4, _staged_paths()


@pytest.mark.parametrize("source", sorted(_relative_bind_sources()))
def test_every_bind_mount_is_staged_into_the_payload(source):
    if source in NOT_IN_THE_PAYLOAD:
        pytest.skip(f"{source}: {NOT_IN_THE_PAYLOAD[source]}")
    # The staging copies directories, so `./nats/nats.conf` is satisfied by a
    # `cp -r .../nats/.` line. Match on the first path segment.
    top = source.lstrip("./").lstrip("../").split("/")[0]
    copied = [c for c in _staged_paths() if f"/{top}/" in c or f"/{top}'" in c]
    assert copied, (
        f"docker-compose.yml bind-mounts {source}, and "
        f"deploy/windows/build-appliance.ps1 does not stage {top!r} into the "
        f"payload. Docker will create the missing path AS A DIRECTORY and the "
        f"container will fail on a config file that is a folder — see the gateway "
        f"note in that script. Either stage it, or add it to NOT_IN_THE_PAYLOAD "
        f"with the reason."
    )


def test_the_installer_generates_every_variable_compose_demands():
    """`${VAR:?}` makes compose refuse to start when VAR is unset — loudly, which
    is right, and useless if the installer never writes VAR. An appliance
    installed before a variable existed has an .env without it, so the installer
    has to ADD it on upgrade as well as generate it on a fresh install."""
    demanded = set(re.findall(r"\$\{([A-Z_][A-Z0-9_]*):\?", COMPOSE.read_text()))
    assert demanded, "no ${VAR:?} in the compose file — this test has nothing to check"

    installer = (REPO / "deploy" / "windows" / "install-appliance.ps1").read_text()
    missing = sorted(v for v in demanded if v not in installer)
    assert not missing, (
        f"docker-compose.yml refuses to start without {missing}, and "
        f"install-appliance.ps1 never writes them to /opt/neubit/.env. Every "
        f"install would fail at `docker compose up`."
    )
