"""P6-C ONVIF-server tests — OUR VMS answering as an ONVIF device.

No network. In-memory SQLite seeded with an enabled OnvifServerConfig + cameras (with
MediaProfiles) + recordings. Asserts, by parsing the SOAP response XML:

  * WS-Security auth: a valid UsernameToken (PasswordText + PasswordDigest) resolves the
    tenant; a wrong/absent token → ``ter:NotAuthorized`` fault.
  * GetDeviceInformation → our make/model.
  * GetProfiles → one profile per exposed camera/stream, with our tokens.
  * GetStreamUri → the MediaMTX RTSP URL (cameras/<tenant>/<cam>/<profile>).
  * GetSnapshotUri → our snapshot endpoint.
  * GetRecordings / GetRecordingSummary → real Recording spans.
  * FindRecordings → token; GetRecordingSearchResults → real recording rows.
  * GetReplayUri → the recorded-playback URL for the segment covering the time.
  * Tenant scoping: another tenant's creds see only their own cameras; the exposed
    allow-list is honoured.
  * Config service upsert (enable + creds + exposed) + enable-without-password guard.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from lxml import etree
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import ValidationError

from app.db import Base
from app.vms.common.crypto import encrypt_secret
from app.vms.models import Camera, MediaProfile, OnvifServerConfig, Recording
from app.vms.onvif_server import auth as onvif_auth
from app.vms.onvif_server import soap
from app.vms.onvif_server.schemas import OnvifServerConfigUpdate
from app.vms.onvif_server.service import OnvifServerService

TENANT = uuid.uuid4()
OTHER = uuid.uuid4()

NS_SOAP = "http://www.w3.org/2003/05/soap-envelope"
NS_WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
NS_WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"


class _Actor:
    user_id = uuid.uuid4()


def _dt(h, m=0):
    return datetime(2026, 7, 9, h, m, tzinfo=timezone.utc)


def _headers(host="cam.example.com"):
    return {"host": host}


# ── WS-Security request envelopes ────────────────────────────────────────────
def _envelope(body_action_xml: str, *, username=None, password=None, digest=False) -> bytes:
    sec = ""
    if username is not None:
        if digest and password is not None:
            nonce = b"0123456789abcdef"
            created = "2026-07-09T10:00:00Z"
            pd = base64.b64encode(
                hashlib.sha1(nonce + created.encode() + password.encode()).digest()
            ).decode()
            pw = (
                f'<Password Type="http://docs.oasis-open.org/wss/2004/01/'
                f'oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{pd}</Password>'
                f'<Nonce>{base64.b64encode(nonce).decode()}</Nonce>'
                f'<Created xmlns="{NS_WSU}">{created}</Created>'
            )
        else:
            pw = f"<Password>{password if password is not None else ''}</Password>"
        sec = (
            f'<Security xmlns="{NS_WSSE}">'
            f"<UsernameToken><Username>{username}</Username>{pw}</UsernameToken>"
            f"</Security>"
        )
    header = f"<soap:Header>{sec}</soap:Header>" if sec else "<soap:Header/>"
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<soap:Envelope xmlns:soap="{NS_SOAP}">'
        f"{header}<soap:Body>{body_action_xml}</soap:Body></soap:Envelope>"
    ).encode()


def _body_get(action: str, ns: str, inner: str = "") -> str:
    return f'<{action} xmlns="{ns}">{inner}</{action}>'


NS_TDS = "http://www.onvif.org/ver10/device/wsdl"
NS_TRT = "http://www.onvif.org/ver10/media/wsdl"
NS_TRC = "http://www.onvif.org/ver10/recording/wsdl"
NS_TSE = "http://www.onvif.org/ver10/search/wsdl"
NS_TRP = "http://www.onvif.org/ver10/replay/wsdl"


def _findall(xml: bytes, localname: str):
    root = etree.fromstring(xml)
    return root.findall(".//{*}" + localname)


def _text(xml: bytes, localname: str):
    els = _findall(xml, localname)
    if not els:
        return None
    # An empty element (``<Uri></Uri>``) reads back as ``None`` in lxml — normalise to
    # "" so "present but empty" is distinguishable from "absent".
    return els[0].text or ""


# ── fixtures ──────────────────────────────────────────────────────────────────
@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


PASSWORD = "s3cret-pass"


@pytest_asyncio.fixture
async def seeded(db):
    cfg = OnvifServerConfig(
        tenant_id=TENANT,
        enabled=True,
        exposed_camera_ids=["*"],
        service_username="onvif-svc",
        service_enc_password=encrypt_secret(PASSWORD),
        device_name="Neubit VMS",
    )
    db.add(cfg)
    # Two exposed cameras; cam-a has main+sub profiles, cam-b none (defaults).
    db.add(Camera(id="cam-a", tenant_id=TENANT, name="Front Door", is_enabled=True, status="online"))
    db.add(Camera(id="cam-b", tenant_id=TENANT, name="Lobby", is_enabled=True, status="online"))
    db.add(MediaProfile(camera_id="cam-a", tenant_id=TENANT, name="main",
                        codec="H265", resolution="2560x1440", fps=30, bitrate=8192))
    db.add(MediaProfile(camera_id="cam-a", tenant_id=TENANT, name="sub",
                        codec="H264", resolution="640x480", fps=15, bitrate=1024))
    # An OTHER-tenant camera + config — must never leak into TENANT's responses.
    db.add(OnvifServerConfig(
        tenant_id=OTHER, enabled=True, exposed_camera_ids=["*"],
        service_username="onvif-other", service_enc_password=encrypt_secret("otherpw"),
    ))
    db.add(Camera(id="cam-x", tenant_id=OTHER, name="Other Cam", is_enabled=True, status="online"))
    # Recordings for cam-a (two 1h segments).
    db.add(Recording(tenant_id=TENANT, camera_id="cam-a", profile="main", path="/rec/a1.mp4",
                     start_time=_dt(9), end_time=_dt(10), duration=3600, file_size=1000,
                     trigger_type="continuous"))
    db.add(Recording(tenant_id=TENANT, camera_id="cam-a", profile="main", path="/rec/a2.mp4",
                     start_time=_dt(10), end_time=_dt(11), duration=3600, file_size=2000,
                     trigger_type="continuous"))
    await db.commit()
    return cfg


async def _soap(db, service, action_xml, *, username="onvif-svc", password=PASSWORD, digest=False):
    """Authenticate + dispatch a fabricated SOAP request → response bytes (or fault)."""
    body = _envelope(action_xml, username=username, password=password, digest=digest)
    config = await onvif_auth.authenticate(body, db)
    if config is None:
        return onvif_auth.fault_response("ter:NotAuthorized", "authentication failed")
    return await soap.handle_soap(
        service, body, config=config, headers=_headers(),
        url_hostname="cam.example.com", scheme="http", soapaction=None, db=db,
    )


# ── auth ──────────────────────────────────────────────────────────────────────
async def test_auth_valid_passwordtext(db, seeded):
    cfg = await onvif_auth.authenticate(
        _envelope(_body_get("GetDeviceInformation", NS_TDS), username="onvif-svc", password=PASSWORD),
        db,
    )
    assert cfg is not None and cfg.tenant_id == TENANT


async def test_auth_valid_passworddigest(db, seeded):
    cfg = await onvif_auth.authenticate(
        _envelope(_body_get("GetDeviceInformation", NS_TDS),
                  username="onvif-svc", password=PASSWORD, digest=True),
        db,
    )
    assert cfg is not None and cfg.tenant_id == TENANT


async def test_auth_wrong_password_fault(db, seeded):
    xml = await _soap(db, "device_service", _body_get("GetDeviceInformation", NS_TDS),
                      password="WRONG")
    assert b"NotAuthorized" in xml
    assert _text(xml, "Manufacturer") is None


async def test_auth_absent_token_fault(db, seeded):
    body = _envelope(_body_get("GetDeviceInformation", NS_TDS))  # no username
    cfg = await onvif_auth.authenticate(body, db)
    assert cfg is None


async def test_auth_disabled_config_rejected(db, seeded):
    seeded.enabled = False
    await db.commit()
    cfg = await onvif_auth.authenticate(
        _envelope(_body_get("GetDeviceInformation", NS_TDS), username="onvif-svc", password=PASSWORD),
        db,
    )
    assert cfg is None


# ── device ────────────────────────────────────────────────────────────────────
async def test_get_device_information(db, seeded):
    xml = await _soap(db, "device_service", _body_get("GetDeviceInformation", NS_TDS))
    assert _text(xml, "Manufacturer") == "Neubit"
    assert _text(xml, "Model") == "Neubit VMS"


async def test_get_services_lists_media_and_recording(db, seeded):
    xml = await _soap(db, "device_service", _body_get("GetServices", NS_TDS))
    xaddrs = [e.text for e in _findall(xml, "XAddr")]
    assert any("media_service" in x for x in xaddrs)
    assert any("recording_service" in x for x in xaddrs)
    assert any("replay_service" in x for x in xaddrs)


async def test_get_capabilities(db, seeded):
    xml = await _soap(db, "device_service", _body_get("GetCapabilities", NS_TDS))
    assert _findall(xml, "GetCapabilitiesResponse")


async def test_get_system_date_and_time(db, seeded):
    xml = await _soap(db, "device_service", _body_get("GetSystemDateAndTime", NS_TDS))
    assert _text(xml, "Year") == "2026"


# ── media ─────────────────────────────────────────────────────────────────────
async def test_get_profiles_one_per_stream(db, seeded):
    xml = await _soap(db, "media_service", _body_get("GetProfiles", NS_TRT))
    profs = _findall(xml, "Profiles")
    tokens = {p.get("token") for p in profs}
    # cam-a → main + sub; cam-b → default main. 3 profiles.
    assert "profile_cam-a__main" in tokens
    assert "profile_cam-a__sub" in tokens
    assert "profile_cam-b__main" in tokens
    assert len(profs) == 3


async def test_get_stream_uri_is_mediamtx_rtsp(db, seeded, monkeypatch):
    monkeypatch.setenv("VE_MEDIAMTX_RTSP_BASE", "rtsp://localhost:8554")
    inner = "<ProfileToken>profile_cam-a__sub</ProfileToken>"
    xml = await _soap(db, "media_service", _body_get("GetStreamUri", NS_TRT, inner))
    uri = _text(xml, "Uri")
    assert uri == f"rtsp://cam.example.com:8554/cameras/{TENANT}/cam-a/sub"


async def test_get_snapshot_uri(db, seeded):
    inner = "<ProfileToken>profile_cam-a__main</ProfileToken>"
    xml = await _soap(db, "media_service", _body_get("GetSnapshotUri", NS_TRT, inner))
    uri = _text(xml, "Uri")
    assert uri == "http://cam.example.com/api/v1/vms/cameras/cam-a/snapshot"


async def test_media2_get_profiles(db, seeded):
    xml = await _soap(db, "media2_service", _body_get("GetProfiles", "http://www.onvif.org/ver20/media/wsdl"))
    assert _findall(xml, "Profiles")


# ── recording (Profile G) ─────────────────────────────────────────────────────
async def test_get_recordings_real_spans(db, seeded):
    xml = await _soap(db, "recording_service", _body_get("GetRecordings", NS_TRC))
    tokens = [e.text for e in _findall(xml, "RecordingToken")]
    assert "rec_cam-a" in tokens
    # cam-a's DataFrom/DataTo reflect the seeded 09:00–11:00 span.
    froms = [e.text for e in _findall(xml, "DataFrom")]
    tos = [e.text for e in _findall(xml, "DataTo")]
    assert "2026-07-09T09:00:00Z" in froms
    assert "2026-07-09T11:00:00Z" in tos


async def test_get_recording_summary(db, seeded):
    xml = await _soap(db, "recording_service", _body_get("GetRecordingSummary", NS_TRC))
    assert _text(xml, "NumberRecordings") == "2"  # cam-a + cam-b exposed


async def test_find_and_get_recording_results(db, seeded):
    x1 = await _soap(db, "search_service", _body_get("FindRecordings", NS_TSE))
    token = _text(x1, "SearchToken")
    assert token and token.startswith("search_")
    inner = f"<SearchToken>{token}</SearchToken>"
    x2 = await _soap(db, "search_service", _body_get("GetRecordingSearchResults", NS_TSE, inner))
    infos = _findall(x2, "RecordingInformation")
    rtokens = [e.text for e in _findall(x2, "RecordingToken")]
    assert "rec_cam-a" in rtokens
    assert infos  # cam-a has recordings


# ── replay (Profile G) ─────────────────────────────────────────────────────────
async def test_get_replay_uri_real_recording(db, seeded):
    inner = ("<RecordingToken>rec_cam-a</RecordingToken>"
             "<StartTime>2026-07-09T09:30:00Z</StartTime>")
    xml = await _soap(db, "replay_service", _body_get("GetReplayUri", NS_TRP, inner))
    uri = _text(xml, "Uri")
    assert uri and "/media/playback/get?" in uri
    assert "cameras/%s/cam-a/main" % TENANT in uri
    assert "start=2026-07-09T09:30:00Z" in uri


async def test_replay_uri_unknown_camera_empty(db, seeded):
    inner = "<RecordingToken>rec_nope</RecordingToken>"
    xml = await _soap(db, "replay_service", _body_get("GetReplayUri", NS_TRP, inner))
    assert _text(xml, "Uri") == ""


# ── tenant scoping ──────────────────────────────────────────────────────────────
async def test_other_tenant_sees_only_own(db, seeded):
    xml = await _soap(db, "media_service", _body_get("GetProfiles", NS_TRT),
                      username="onvif-other", password="otherpw")
    tokens = {p.get("token") for p in _findall(xml, "Profiles")}
    assert tokens == {"profile_cam-x__main"}  # only OTHER's camera, none of TENANT's


async def test_exposed_allowlist_honoured(db, seeded):
    seeded.exposed_camera_ids = ["cam-a"]  # hide cam-b
    await db.commit()
    xml = await _soap(db, "media_service", _body_get("GetProfiles", NS_TRT))
    tokens = {p.get("token") for p in _findall(xml, "Profiles")}
    assert all(t.startswith("profile_cam-a") for t in tokens)
    assert not any("cam-b" in t for t in tokens)


async def test_stream_uri_cross_tenant_camera_empty(db, seeded):
    # TENANT creds asking for OTHER's camera → empty (not exposed to this tenant).
    inner = "<ProfileToken>profile_cam-x__main</ProfileToken>"
    xml = await _soap(db, "media_service", _body_get("GetStreamUri", NS_TRT, inner))
    assert _text(xml, "Uri") == ""


# ── config service ──────────────────────────────────────────────────────────────
def _scope(t=TENANT):
    return Scope(tenant_id=t, is_superadmin=False)


async def test_config_upsert_and_read(db):
    svc = OnvifServerService(db, _scope())
    default = await svc.get()  # transient default
    assert default.enabled is False
    row = await svc.upsert(
        OnvifServerConfigUpdate(
            enabled=True, service_username="my-onvif", service_password="pw123",
            exposed_camera_ids=["cam-a"], device_name="Gate VMS",
            advertised_rtsp_port=8554,
        ),
        actor=_Actor(),
    )
    assert row.enabled and row.tenant_id == TENANT
    assert row.service_enc_password and row.service_enc_password.startswith("enc:")
    got = await svc.get()
    assert got.service_username == "my-onvif"
    assert got.exposed_camera_ids == ["cam-a"]


async def test_enable_without_password_rejected(db):
    svc = OnvifServerService(db, _scope())
    with pytest.raises(ValidationError):
        await svc.upsert(OnvifServerConfigUpdate(enabled=True), actor=_Actor())


async def test_duplicate_username_rejected(db, seeded):
    # A DIFFERENT tenant tries to claim TENANT's existing username.
    svc = OnvifServerService(db, _scope(uuid.uuid4()))
    with pytest.raises(ValidationError):
        await svc.upsert(
            OnvifServerConfigUpdate(service_username="onvif-svc", service_password="x"),
            actor=_Actor(),
        )
