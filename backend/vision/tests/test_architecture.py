"""The VMS must not become an NVR.

There is a separate NVR. It owns the devices and the disks: it holds the camera
credentials, runs the brand drivers, writes the segments, and owns storage,
retention and tiering. The VMS aggregates across recorders and tenants and issues
OPERATOR commands to them. That is the whole architecture, and it has been written
down before — in module docstrings, in a plan file, in a memory note — and it drifted
back anyway, every time, because prose does not fail a build.

The dividing line these tests enforce:

    does it touch a device or a disk        → the NVR
    does it span more than one recorder     → the VMS

and, for the federation surface specifically:

    does the act END when the operator stops doing it   → operator work, proxy it
    does it persist and change what LATER acts mean     → config authorship, do not

The second pair is why driving a relay's state is proxied and writing its IdleState
is not: IdleState decides which way every future drive pushes the contact.

These tests are deliberately blunt. A route that has to be argued about is a route
whose argument belongs in a code review, and adding it here is how that argument gets
recorded rather than repeated.
"""

from __future__ import annotations

import pathlib

import pytest

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


def _routes(app) -> set[str]:
    """Every mounted method+path, read off the OpenAPI schema.

    Not ``app.routes``: this FastAPI wraps every ``include_router`` in a lazy
    ``_IncludedRouter`` whose children are not reachable as plain routes, so walking
    the route tree returns eleven entries — the docs, health, readyz, whoami — and
    none of the API. A version of this that walked ``app.routes`` would have passed
    every assertion below while proving nothing, which is why the scan is guarded.
    """
    schema = app.openapi()
    return {
        f"{method.upper()} {path}"
        for path, ops in schema.get("paths", {}).items()
        for method in ops
        if method.lower() in {"get", "post", "put", "patch", "delete", "head", "options"}
    }


def test_the_route_scan_finds_something(app):
    """A scan that matches nothing makes every assertion below vacuous."""
    assert len(_routes(app)) > 100


# Modules that were the VMS's own device/storage plane. Each one duplicated
# something the NVR already does over HTTP, and each is gone. The point of naming
# them is that "re-add it under a new name" is a decision somebody has to make out
# loud, by editing this list.
RETIRED_MODULES = [
    "vms/onvif_server",  # an ONVIF *server* re-exporting cameras the NVR serves
    "vms/devicemgmt",    # camera NTP, user accounts, config backup/restore
    "vms/ptz",           # a second PTZ plane, and a second patrol cycler on one head
]


@pytest.mark.parametrize("module", RETIRED_MODULES)
def test_a_retired_device_plane_module_stays_retired(module):
    # __init__.py, not the directory: a stale __pycache__ keeps the directory alive
    # long after the package is gone, and this test would then always fail.
    assert not (APP / module / "__init__.py").exists(), (
        f"app/{module} is back. It was removed because the NVR already owns that "
        f"operation and owning it twice is how the VMS turns into an NVR."
    )


# Federated writes that would be CONFIG AUTHORSHIP over somebody else's recorder.
# The node refuses every one of them to a federation credential on purpose
# (vms.camera.manage is withheld from federationGrants), so proxying them can only
# ever produce a 403 dressed up as a 502 — and if the node's grant set were ever
# widened to make them work, the VMS would have acquired the right to reconfigure a
# recorder it does not own.
FORBIDDEN_FEDERATED_WRITES = [
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/video",
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/audio",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/osd",
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/osd/{osd_token}",
    "DELETE /vms/federation/nodes/{node_id}/cameras/{camera_id}/osd/{osd_token}",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/masks",
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/masks/{mask_token}",
    "DELETE /vms/federation/nodes/{node_id}/cameras/{camera_id}/masks/{mask_token}",
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/motion",
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/io/relays/{token}",
]


def _is_mounted(mounted: set[str], entry: str) -> bool:
    """Does ``"METHOD /suffix"`` name a mounted route?

    Method and path suffix are compared SEPARATELY. Comparing the whole string was
    the first version and it could never fire: mounted paths carry the /api/v1
    prefix, so neither ``entry in mounted_route`` nor ``mounted_route.endswith(entry)``
    is ever true once the method sits in front of the path. It was caught by trying
    to break the test and watching it stay green.
    """
    method, suffix = entry.split(" ", 1)
    return any(
        m.split(" ", 1)[0] == method and m.split(" ", 1)[1].endswith(suffix)
        for m in mounted
    )


def test_the_vms_does_not_proxy_config_authorship_to_a_node(app):
    mounted = _routes(app)
    back = [r for r in FORBIDDEN_FEDERATED_WRITES if _is_mounted(mounted, r)]
    assert not back, (
        "these routes rewrite a node-owned camera's CONFIGURATION through the VMS:\n  "
        + "\n  ".join(back)
        + "\nThose screens belong to the owning node's own console. Read the state if the "
          "console needs to show it; do not author it here."
    )


# The other half, and the one that is easy to lose by accident: the operator commands
# the VMS SHOULD proxy. Losing one of these silently turns a working federated console
# into a read-only one.
# Method AND path: every one of these is a WRITE. Matching on the path alone would
# let a GET of the same resource satisfy the assertion, which is exactly the
# degradation being guarded against — a console that can see everything and command
# nothing still answers every read.
REQUIRED_FEDERATED_OPERATIONS = [
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/ptz",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/exports",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/motion-search",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/talk",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/talk/uplink",
    # The evidence trio. Without these an export is a file with no provenance, which
    # is the whole reason the VMS stopped producing its own.
    "POST /vms/federation/nodes/{node_id}/exports/{export_id}/verify",
    "GET /vms/federation/nodes/{node_id}/exports/{export_id}/manifest",
    "GET /vms/federation/nodes/{node_id}/exports/public-key",
    "PUT /vms/federation/nodes/{node_id}/cameras/{camera_id}/imaging",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/io/relays/{token}/state",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/recording/start",
    "POST /vms/federation/nodes/{node_id}/cameras/{camera_id}/reboot",
]


@pytest.mark.parametrize("path", REQUIRED_FEDERATED_OPERATIONS)
def test_the_operator_command_surface_is_still_mounted(app, path):
    assert _is_mounted(_routes(app), path), (
        f"{path} is gone. The VMS issues operator commands to the recorders it "
        f"aggregates; without them it is a viewer, not a VMS."
    )


# Recording POLICY belongs to the recorder: mode, weekly schedule, retention, and
# the reconcile that enforces them every tick. The VMS keeps only the read model —
# a segment row per finalized file, browsable across recorders, which is the one
# thing no single recorder can answer.
FORBIDDEN_RECORDING_CONTROL = [
    "PUT /vms/cameras/{camera_id}/recording",
    "POST /vms/cameras/{camera_id}/recording/start",
    "POST /vms/cameras/{camera_id}/recording/stop",
]


def test_the_vms_does_not_configure_or_drive_recording(app):
    mounted = _routes(app)
    back = [r for r in FORBIDDEN_RECORDING_CONTROL if _is_mounted(mounted, r)]
    assert not back, (
        "the VMS is setting or driving recording again:\n  " + "\n  ".join(back)
        + "\nThe recorder reconciles its own recording modes every tick — a second "
          "scheduler here means two things starting and stopping one recording. "
          "Manual control goes through /vms/federation/…/recording/{start,stop}."
    )


def test_the_recording_read_model_is_still_browsable(app):
    """The other half. Without these the estate has no cross-recorder footage index,
    which is the part of recording the VMS legitimately owns."""
    mounted = _routes(app)
    for route in ("GET /vms/cameras/{camera_id}/recordings", "GET /vms/recordings/{rec_id}"):
        assert _is_mounted(mounted, route), f"{route} is gone"


def test_storage_stays_a_read_model(app):
    """The NVR owns storage, retention, tiering and RAID.

    Two movers on one /recordings volume is a data-loss race, which is why the VMS's
    storage DATA-plane was retired. Reading a node's usage to display it is fine;
    mounting a write here means the VMS has started deciding where footage lives.
    """
    writes = [
        r for r in _routes(app)
        if "/vms/storage" in r and r.split(" ", 1)[0] in {"POST", "PUT", "PATCH", "DELETE"}
    ]
    assert not writes, (
        "the VMS is writing storage topology again:\n  " + "\n  ".join(sorted(writes))
    )
