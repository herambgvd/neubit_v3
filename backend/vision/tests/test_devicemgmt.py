"""Device / fleet-management tests (G7).

Two layers, no live devices:

  * Driver request-build per op per brand — the ``_http`` strict/GET/bytes helpers (Hik
    ISAPI, Dahua/CP-Plus CGI) are monkeypatched to capture the request the driver builds,
    so the endpoint + method + body construction run for real. ONVIF's SDK-backed ops are
    exercised for the graceful no-SDK path (onvif-zeep absent in the test env). Lumina
    inherits the base defaults → asserts graceful ``supported=False``.
  * Service bulk fan-out — an in-memory SQLite DB seeded with cameras across two tenants;
    ``get_driver`` monkeypatched to a fake driver so we assert per-camera results, that one
    camera's failure doesn't abort the batch, and that a foreign-tenant id drops out.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

import app.vms.drivers._http as http_mod
from app.db import Base
from app.vms.common.crypto import encrypt_secret
from app.vms.drivers import (
    ConfigBackup,
    CpPlusDriver,
    Credentials,
    FleetOpResult,
    HikvisionDriver,
    LuminaDriver,
    OnvifDriver,
)
from app.vms.models import Camera

CREDS = Credentials(username="admin", password="pass12", port=80, rtsp_port=554)

TENANT = uuid.uuid4()
OTHER = uuid.uuid4()


def _scope(t=TENANT):
    return Scope(tenant_id=t, is_superadmin=False)


# ── Hikvision (ISAPI) driver request-build ────────────────────────────────────────
async def test_hik_reboot_puts_isapi_reboot(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured.update(method=method, url=url)
        return "<ResponseStatus/>"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().reboot("10.0.0.5", CREDS)
    assert res.ok is True
    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/ISAPI/System/reboot")


async def test_hik_set_ntp_builds_ntpservers_body(monkeypatch):
    calls = []

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        calls.append((url, content))
        return "<ResponseStatus/>"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().set_ntp("10.0.0.5", CREDS, "pool.ntp.org")
    assert res.ok is True and res.data["server"] == "pool.ntp.org"
    # First call hits ntpServers with the hostName in the body.
    url0, body0 = calls[0]
    assert url0.endswith("/ISAPI/System/time/ntpServers/1")
    assert "<hostName>pool.ntp.org</hostName>" in body0


async def test_hik_set_password_resolves_user_id(monkeypatch):
    users_xml = (
        "<UserList><User><id>1</id><userName>admin</userName></User>"
        "<User><id>2</id><userName>ops</userName></User></UserList>"
    )
    captured = {}

    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return users_xml if url.endswith("/ISAPI/Security/users") else None

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured.update(method=method, url=url, content=content)
        return "<ResponseStatus/>"

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().set_password("10.0.0.5", CREDS, user="ops", new_password="Newpass1!")
    assert res.ok is True
    assert captured["url"].endswith("/ISAPI/Security/users/2")  # resolved ops → id 2
    assert "<password>Newpass1!</password>" in captured["content"]


async def test_hik_set_password_unknown_user_graceful(monkeypatch):
    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return "<UserList><User><id>1</id><userName>admin</userName></User></UserList>"

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    res = await HikvisionDriver().set_password("10.0.0.5", CREDS, user="ghost", new_password="x")
    assert res.ok is False and "not found" in res.detail


async def test_hik_backup_config_returns_blob(monkeypatch):
    async def _get_bytes(url, user, password, *, verify_tls=False, timeout=8.0):
        assert url.endswith("/ISAPI/System/configurationData")
        return b"HIKCONFIGBLOB"

    monkeypatch.setattr(http_mod, "get_bytes", _get_bytes)
    backup = await HikvisionDriver().backup_config("10.0.0.5", CREDS)
    assert backup.supported is True and backup.blob == b"HIKCONFIGBLOB"
    assert backup.filename.endswith("-config.bin")


async def test_hik_backup_config_unreachable_graceful(monkeypatch):
    async def _get_bytes(url, user, password, *, verify_tls=False, timeout=8.0):
        return None

    monkeypatch.setattr(http_mod, "get_bytes", _get_bytes)
    backup = await HikvisionDriver().backup_config("10.0.0.5", CREDS)
    assert backup.supported is False and backup.blob is None


async def test_hik_reboot_failure_is_graceful(monkeypatch):
    async def _strict(*a, **k):
        raise http_mod.BrandHTTPError(500, "boom")

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().reboot("10.0.0.5", CREDS)
    assert res.ok is False and res.supported is True  # ran but failed


# ── CP-Plus / Dahua (CGI) driver request-build ────────────────────────────────────
async def test_cpplus_reboot_hits_magicbox(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured.update(method=method, url=url)
        return "OK"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await CpPlusDriver().reboot("10.0.0.7", CREDS)
    assert res.ok is True
    assert "magicBox.cgi?action=reboot" in captured["url"]


async def test_cpplus_set_ntp_builds_setconfig(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return "OK"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await CpPlusDriver().set_ntp("10.0.0.7", CREDS, "pool.ntp.org")
    assert res.ok is True
    assert "action=setConfig" in captured["url"]
    assert "NTP.Address=pool.ntp.org" in captured["url"]


async def test_cpplus_set_password_uses_usermanager(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return "OK"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await CpPlusDriver().set_password("10.0.0.7", CREDS, user="ops", new_password="Newpass1")
    assert res.ok is True
    assert "userManager.cgi?action=modifyPassword" in captured["url"]
    assert "name=ops" in captured["url"] and "pwd=Newpass1" in captured["url"]


async def test_cpplus_backup_config_blob(monkeypatch):
    async def _get_bytes(url, user, password, *, verify_tls=False, timeout=8.0):
        assert "Config.backup" in url
        return b"DAHUACONFIG"

    monkeypatch.setattr(http_mod, "get_bytes", _get_bytes)
    backup = await CpPlusDriver().backup_config("10.0.0.7", CREDS)
    assert backup.supported is True and backup.blob == b"DAHUACONFIG"


# ── Lumina inherits base defaults → graceful unsupported ──────────────────────────
async def test_lumina_ops_unsupported_graceful():
    d = LuminaDriver()
    reb = await d.reboot("10.0.0.9", CREDS)
    assert reb.ok is False and reb.supported is False
    ntp = await d.set_ntp("10.0.0.9", CREDS, "pool.ntp.org")
    assert ntp.ok is False and ntp.supported is False
    backup = await d.backup_config("10.0.0.9", CREDS)
    assert backup.supported is False


# ── ONVIF SDK-backed ops → graceful when onvif-zeep absent in the test env ────────
async def test_onvif_ops_graceful_without_sdk(monkeypatch):
    # Force the no-SDK branch regardless of whether onvif-zeep happens to be installed.
    import app.vms.drivers.onvif as onvif_mod

    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", False)
    d = OnvifDriver()
    res = await d.reboot("10.0.0.1", CREDS)
    assert res.ok is False and res.supported is False
    backup = await d.backup_config("10.0.0.1", CREDS)
    assert backup.supported is False


async def test_get_device_info_delegates_to_probe(monkeypatch):
    # get_device_info default → probe. Hik probe parses deviceInfo XML.
    from tests import fixtures as fx

    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return fx.HIK_DEVICE_INFO if "deviceInfo" in url else None

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    info = await HikvisionDriver().get_device_info("10.0.0.5", CREDS)
    assert info.reachable is True and info.firmware == "V4.30.005"


# ── Service bulk fan-out (in-memory DB + fake driver) ─────────────────────────────
@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


def _cam(cid, tenant, host="10.0.0.5", brand="hikvision", name=None):
    return Camera(
        id=cid, tenant_id=tenant, name=name or cid, connection_type="onvif", status="online",
        brand=brand, onvif_host=host, onvif_port=80, onvif_user="admin",
        onvif_enc_pass=encrypt_secret("pass12"), network_info={"ip": host},
    )


@pytest_asyncio.fixture
async def seeded(db):
    db.add(_cam("cam-a", TENANT, name="Cam A"))
    db.add(_cam("cam-b", TENANT, name="Cam B"))
    db.add(_cam("cam-nohost", TENANT, host=None, name="No Host"))
    db.add(_cam("cam-other", OTHER, name="Foreign"))
    await db.commit()


class _FakeDriver:
    """Records the op it was asked to run; ``fail_hosts`` return ok=False."""

    calls: list = []

    def __init__(self, brand="hikvision"):
        self.brand = brand

    async def reboot(self, host, creds):
        _FakeDriver.calls.append(("reboot", host))
        if host in _FakeDriver.fail_hosts:
            return FleetOpResult(ok=False, detail="simulated failure")
        return FleetOpResult(ok=True, detail="reboot requested")

    async def set_ntp(self, host, creds, server):
        _FakeDriver.calls.append(("ntp", host, server))
        return FleetOpResult(ok=True, detail=f"ntp {server}")

    async def set_password(self, host, creds, *, user, new_password):
        _FakeDriver.calls.append(("password", host, user))
        return FleetOpResult(ok=True, detail="pw changed")

    async def aclose(self):
        return None


_FakeDriver.fail_hosts = set()


def _patch_driver(monkeypatch):
    _FakeDriver.calls = []
    _FakeDriver.fail_hosts = set()
    monkeypatch.setattr("app.vms.devicemgmt.service.get_driver", lambda brand: _FakeDriver(brand))


async def test_bulk_reboot_fans_out(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    svc = DeviceMgmtService(db, _scope())
    res = await svc.bulk("reboot", ["cam-a", "cam-b"])
    assert res["total"] == 2 and res["succeeded"] == 2
    hosts = {h for op, h in _FakeDriver.calls if op == "reboot"}
    assert hosts == {"10.0.0.5"}
    assert all(item["ok"] for item in res["items"])


async def test_bulk_one_failure_does_not_abort(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    _FakeDriver.fail_hosts = {"10.0.0.5"}  # both cam-a and cam-b share this host → both fail
    # Give cam-b a distinct reachable host so exactly one fails.
    row = await db.get(Camera, "cam-b")
    row.onvif_host = "10.0.0.6"
    row.network_info = {"ip": "10.0.0.6"}
    await db.commit()

    svc = DeviceMgmtService(db, _scope())
    res = await svc.bulk("reboot", ["cam-a", "cam-b"])
    assert res["total"] == 2 and res["succeeded"] == 1
    by_id = {i["camera_id"]: i for i in res["items"]}
    assert by_id["cam-a"]["ok"] is False
    assert by_id["cam-b"]["ok"] is True


async def test_bulk_nohost_reports_unreachable(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    svc = DeviceMgmtService(db, _scope())
    res = await svc.bulk("reboot", ["cam-nohost"])
    assert res["total"] == 1 and res["succeeded"] == 0
    assert res["items"][0]["ok"] is False


async def test_bulk_tenant_isolation(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    # Caller in TENANT asks to reboot a foreign camera + an owned one.
    svc = DeviceMgmtService(db, _scope())
    res = await svc.bulk("reboot", ["cam-a", "cam-other"])
    # Foreign camera drops out entirely (not owned).
    assert res["total"] == 1
    assert {i["camera_id"] for i in res["items"]} == {"cam-a"}


async def test_bulk_ntp_requires_server(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    svc = DeviceMgmtService(db, _scope())
    res = await svc.bulk("ntp", ["cam-a"], server=None)
    assert res["items"][0]["ok"] is False and "server required" in res["items"][0]["detail"]


async def test_bulk_password_fans_out(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    svc = DeviceMgmtService(db, _scope())
    res = await svc.bulk("password", ["cam-a"], user="ops", new_password="Newpass1")
    assert res["succeeded"] == 1
    assert ("password", "10.0.0.5", "ops") in _FakeDriver.calls


async def test_service_per_camera_reboot_owned(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService

    _patch_driver(monkeypatch)
    svc = DeviceMgmtService(db, _scope())
    res = await svc.reboot("cam-a")
    assert res.ok is True


async def test_service_cross_tenant_404(db, seeded, monkeypatch):
    from app.vms.devicemgmt.service import DeviceMgmtService
    from kernel.errors import NotFoundError

    _patch_driver(monkeypatch)
    svc = DeviceMgmtService(db, _scope())
    with pytest.raises(NotFoundError):
        await svc.reboot("cam-other")
