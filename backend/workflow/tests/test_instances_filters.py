"""DB-backed tests for the incident (WorkflowInstance) list cross-link filters.

Uses an in-memory aiosqlite engine (portable generic column types build on
SQLite). Exercises the two new filters added for the camera-event ↔ incident
cross-link, plus the derived InstancePublic fields:

  * ?source=<domain>  — filter by the EventBus source tag on the envelope
    (trigger_data.source): "vision" (camera), "access", "ingest".
  * ?source=manual     — operator-raised incidents (no trigger envelope).
  * ?event_id=<id>     — match EITHER the bus-envelope id (WorkflowInstance.event_id)
    OR the ORIGINATING event id in the payload (trigger_data.payload.event_id), so a
    lookup by a camera-event id (VmsEvent.id) finds the incident it spawned.
  * InstancePublic.from_row derives event_source + source_event_id from the envelope.
  * Tenant scoping stays intact under the new filters.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.workflow.models import WorkflowInstance
from app.workflow.service import InstanceService
from app.workflow import schemas as S

from kernel.auth import Scope


def _run(coro):
    return asyncio.run(coro)


async def _make_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(
            lambda c: Base.metadata.create_all(c, tables=[WorkflowInstance.__table__])
        )
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    return engine, sm


TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def _camera_envelope(*, bus_event_id: str, vms_event_id: str, source="vision",
                     event_type="vms.camera.motion", camera_id="cam-1"):
    """A canonical camera-event envelope as stored in trigger_data by correlation."""
    return {
        "event_id": bus_event_id,          # bus envelope UUID (→ WorkflowInstance.event_id)
        "tenant_id": str(TENANT_A),
        "type": event_type,
        "source": source,                  # EventBus domain tag
        "occurred_at": "2026-07-10T10:00:00+00:00",
        "payload": {
            "event_id": vms_event_id,      # the REAL camera event id (VmsEvent.id)
            "camera_id": camera_id,
            "event_type": "motion",
            "source": "onvif",             # driver-level source (inside payload)
        },
    }


def _add(session, *, tenant_id, name, trigger_data=None, event_id=None,
         event_type=None, extra=None, status="active", priority="medium"):
    row = WorkflowInstance(
        tenant_id=tenant_id, sop_id="sop-1", sop_name="SOP",
        name=name, priority=priority, status=status,
        trigger_data=trigger_data, event_id=event_id, event_type=event_type,
        extra=extra, timeline=[],
    )
    session.add(row)
    return row


def test_source_filter_camera_vs_access_vs_manual():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                _add(session, tenant_id=TENANT_A, name="cam",
                     trigger_data=_camera_envelope(bus_event_id="bus-1", vms_event_id="vms-1"),
                     event_id="bus-1", event_type="vms.camera.motion")
                _add(session, tenant_id=TENANT_A, name="access",
                     trigger_data={"event_id": "bus-2", "source": "access",
                                   "type": "access.door.forced", "payload": {"event_id": "acc-1"}},
                     event_id="bus-2", event_type="access.door.forced")
                _add(session, tenant_id=TENANT_A, name="ingest",
                     trigger_data={"event_id": "bus-3", "source": "ingest",
                                   "type": "ingest.event.received", "payload": {}},
                     event_id="bus-3")
                # Operator-raised: no envelope.
                _add(session, tenant_id=TENANT_A, name="manual", trigger_data=None)
                await session.commit()

                svc = InstanceService(session, Scope(tenant_id=TENANT_A, is_superadmin=False))

                cam, n = await svc.list_(source="vision")
                assert n == 1 and [r.name for r in cam] == ["cam"]

                acc, n = await svc.list_(source="access")
                assert n == 1 and acc[0].name == "access"

                ing, n = await svc.list_(source="ingest")
                assert n == 1 and ing[0].name == "ingest"

                man, n = await svc.list_(source="manual")
                assert n == 1 and man[0].name == "manual"

                allrows, n = await svc.list_()
                assert n == 4
        finally:
            await engine.dispose()

    _run(go())


def test_event_id_matches_camera_event_id_and_envelope_id():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                _add(session, tenant_id=TENANT_A, name="from-cam",
                     trigger_data=_camera_envelope(bus_event_id="bus-9", vms_event_id="vms-42"),
                     event_id="bus-9", event_type="vms.camera.motion")
                _add(session, tenant_id=TENANT_A, name="unrelated",
                     trigger_data=_camera_envelope(bus_event_id="bus-10", vms_event_id="vms-99"),
                     event_id="bus-10")
                await session.commit()

                svc = InstanceService(session, Scope(tenant_id=TENANT_A, is_superadmin=False))

                # Lookup by the CAMERA event id (the cross-link the UI uses).
                by_cam, n = await svc.list_(event_id="vms-42")
                assert n == 1 and by_cam[0].name == "from-cam"

                # Lookup by the bus-envelope id also works.
                by_bus, n = await svc.list_(event_id="bus-9")
                assert n == 1 and by_bus[0].name == "from-cam"

                # A camera event with no incident → no match.
                none, n = await svc.list_(event_id="vms-does-not-exist")
                assert n == 0
        finally:
            await engine.dispose()

    _run(go())


def test_public_schema_derives_event_source_and_source_event_id():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                cam = _add(session, tenant_id=TENANT_A, name="cam",
                           trigger_data=_camera_envelope(bus_event_id="bus-1", vms_event_id="vms-7"),
                           event_id="bus-1")
                man = _add(session, tenant_id=TENANT_A, name="manual", trigger_data=None)
                await session.commit()
                await session.refresh(cam)
                await session.refresh(man)

                pub_cam = S.InstancePublic.from_row(cam)
                assert pub_cam.event_source == "vision"
                assert pub_cam.source_event_id == "vms-7"
                assert pub_cam.event_id == "bus-1"

                pub_man = S.InstancePublic.from_row(man)
                assert pub_man.event_source == "manual"
                assert pub_man.source_event_id is None
        finally:
            await engine.dispose()

    _run(go())


def test_filters_respect_tenant_scope():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                _add(session, tenant_id=TENANT_A, name="a-cam",
                     trigger_data=_camera_envelope(bus_event_id="bus-a", vms_event_id="vms-a"),
                     event_id="bus-a")
                _add(session, tenant_id=TENANT_B, name="b-cam",
                     trigger_data=_camera_envelope(bus_event_id="bus-b", vms_event_id="vms-b"),
                     event_id="bus-b")
                await session.commit()

                svc_a = InstanceService(session, Scope(tenant_id=TENANT_A, is_superadmin=False))
                # Tenant A never sees tenant B's rows, even matching the filter shape.
                cam, n = await svc_a.list_(source="vision")
                assert n == 1 and cam[0].name == "a-cam"
                # Tenant A cannot fetch tenant B's incident by B's camera-event id.
                none, n = await svc_a.list_(event_id="vms-b")
                assert n == 0
        finally:
            await engine.dispose()

    _run(go())
