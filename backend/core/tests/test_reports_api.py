"""Report jobs — a tenant-owned resource with two permissions and a file behind it.

Reading the job list and downloading what a job produced are separate permissions:
the list is a status board, the download is the data itself.

Three properties, each of which has been wrong somewhere in this codebase:

  * the two permissions are distinct — ``report.read`` must not open a download;
  * the list and the by-id path agree about what belongs to whom (``scoped()``
    excluding NULL rows while ``owns()`` admitted them was an escalation);
  * a platform job (``tenant_id`` NULL) is a super-admin's own report, not a shared
    one, and is out of every tenant's reach.

Jobs are inserted directly so the read paths do not depend on the create route.
"""


import uuid

import pytest
import pytest_asyncio

from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.reports.models import ReportJob
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
REPORTS = f"{PREFIX}/reports"


@pytest.fixture(autouse=True)
def writable_storage(tmp_path, monkeypatch):
    """The harness mounts the tree read-only, so ./data/storage cannot be created
    when the download route resolves a URL. Same as tests/test_upload_hardening.py."""
    from app.core import config, storage

    monkeypatch.setenv("VE_STORAGE_LOCAL_DIR", str(tmp_path / "storage"))
    config.get_settings.cache_clear()
    storage.get_storage.cache_clear()
    yield
    config.get_settings.cache_clear()
    storage.get_storage.cache_clear()


@pytest_asyncio.fixture
async def world(db):
    """Two tenants. Tenant A has both a full reporting user and a read-only one, so
    the permissions can be told apart without also changing tenant."""
    full = await make_role(db, "Reporter", ["report.read", "report.export"])
    readonly = await make_role(db, "ReportViewer", ["report.read"])
    none = await make_role(db, "NoReports", ["sites.read"])
    platform = await make_role(db, "Platform", ["*"])

    async def _tenant(name, slug):
        t = Tenant(name=name, slug=slug, status="active", features={}, limits={})
        db.add(t)
        await db.commit()
        await db.refresh(t)
        return t

    async def _user(email, tenant_id, role, superadmin=False):
        u = User(
            email=email, full_name=email.split("@")[0], role_id=role.id,
            password_hash=hash_password("Passw0rd!"), is_active=True,
            tenant_id=tenant_id, is_superadmin=superadmin,
        )
        db.add(u)
        await db.commit()
        await db.refresh(u)
        await db.refresh(u, attribute_names=["role"])
        return u

    ta = await _tenant("Acme", "rep-acme")
    tb = await _tenant("Globex", "rep-globex")
    return {
        "db": db,
        "ta": ta,
        "tb": tb,
        "a": await _user("rep-a@x.io", ta.id, full),
        "a_readonly": await _user("rep-a-ro@x.io", ta.id, readonly),
        "a_nothing": await _user("rep-a-no@x.io", ta.id, none),
        "b": await _user("rep-b@x.io", tb.id, full),
        "sa": await _user("rep-sa@x.io", None, platform, superadmin=True),
    }


async def _job(db, tenant_id, *, name="Nightly export", status="pending", key=None) -> ReportJob:
    row = ReportJob(
        name=name, format="csv", status=status, result_key=key,
        requested_by=None, tenant_id=tenant_id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


# --- the permission, both directions -----------------------------------------
async def test_listing_reports_needs_the_read_permission(app, world):
    """Both legs: a 403-only test passes against a route that refuses everyone."""
    await _job(world["db"], world["ta"].id)
    async with api_client(app) as c:
        refused = await c.get(REPORTS, headers=bearer(world["a_nothing"]))
        allowed = await c.get(REPORTS, headers=bearer(world["a_readonly"]))
    assert refused.status_code == 403, refused.text
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["total"] == 1


async def test_requesting_an_export_needs_more_than_permission_to_read_one(app, world):
    """Creating a job extracts data rather than looking at a list, so a "view
    reports" role must not be able to queue one."""
    async with api_client(app) as c:
        refused = await c.post(
            REPORTS, headers=bearer(world["a_readonly"]), json={"name": "Q1", "format": "csv"}
        )
        allowed = await c.post(
            REPORTS, headers=bearer(world["a"]), json={"name": "Q1", "format": "csv"}
        )
    assert refused.status_code == 403, refused.text
    assert allowed.status_code == 201, allowed.text
    assert allowed.json()["status"] == "pending"
    assert allowed.json()["requested_by"] == str(world["a"].id)


async def test_downloading_a_finished_report_needs_the_export_permission(app, world):
    """The read permission shows that a report exists and what it is called; export
    hands over its contents. Collapsing the two turns a status board into a data tap.

    Asserted on the reader's own tenant's job, so the refusal can only be about the
    permission and not about ownership.
    """
    job = await _job(world["db"], world["ta"].id, status="done", key="reports/acme-q1.csv")
    async with api_client(app) as c:
        refused = await c.get(f"{REPORTS}/{job.id}/download", headers=bearer(world["a_readonly"]))
        listed = await c.get(f"{REPORTS}/{job.id}", headers=bearer(world["a_readonly"]))
        allowed = await c.get(f"{REPORTS}/{job.id}/download", headers=bearer(world["a"]))
    assert refused.status_code == 403, refused.text
    # The same reader still sees the job itself: a narrower refusal, not a broken
    # route.
    assert listed.status_code == 200 and listed.json()["status"] == "done"
    assert allowed.status_code == 200, allowed.text
    assert "acme-q1.csv" in allowed.json()["url"]


async def test_a_report_that_is_not_finished_has_nothing_to_download(app, world):
    """A URL for a job with no file is a link to a 404 the user reads as data loss;
    422 says "not yet"."""
    pending = await _job(world["db"], world["ta"].id, status="pending")
    failed = await _job(world["db"], world["ta"].id, status="failed")
    async with api_client(app) as c:
        p = await c.get(f"{REPORTS}/{pending.id}/download", headers=bearer(world["a"]))
        f = await c.get(f"{REPORTS}/{failed.id}/download", headers=bearer(world["a"]))
    assert p.status_code == 422, p.text
    assert f.status_code == 422, f.text


async def test_an_unsupported_export_format_is_refused_at_the_request(app, world):
    """The format decides the content type the file is served with, so an unvalidated
    one queues a job that fails hours later in the worker."""
    async with api_client(app) as c:
        r = await c.post(
            REPORTS, headers=bearer(world["a"]), json={"name": "Q1", "format": "exe"}
        )
    assert r.status_code == 422, r.text


# --- isolation: the list side and the by-id side, separately -----------------
async def test_the_report_list_shows_only_the_callers_own_tenants_jobs(app, world):
    """The list side. A report name alone is disclosure — "Payroll export — Globex"
    tells one customer what another is doing, before anything is downloaded."""
    mine = await _job(world["db"], world["ta"].id, name="Acme nightly")
    theirs = await _job(world["db"], world["tb"].id, name="Globex payroll")
    platform = await _job(world["db"], None, name="Platform usage")

    async with api_client(app) as c:
        r = await c.get(REPORTS, headers=bearer(world["a"]))

    assert r.status_code == 200, r.text
    assert [j["id"] for j in r.json()["items"]] == [str(mine.id)]
    assert r.json()["total"] == 1
    assert str(theirs.id) not in r.text
    assert str(platform.id) not in r.text


async def test_another_tenants_job_is_not_found_rather_than_forbidden(app, world):
    """The by-id side, checked separately from the list because the two have
    disagreed before. 404 and not 403, so a tenant cannot confirm that an id exists
    somewhere else.
    """
    theirs = await _job(world["db"], world["tb"].id, status="done", key="reports/globex.csv")
    async with api_client(app) as c:
        got = await c.get(f"{REPORTS}/{theirs.id}", headers=bearer(world["a"]))
        downloaded = await c.get(f"{REPORTS}/{theirs.id}/download", headers=bearer(world["a"]))
    assert got.status_code == 404, got.text
    assert downloaded.status_code == 404, downloaded.text


async def test_a_platform_job_is_out_of_reach_of_every_tenant(app, world):
    """A NULL tenant_id here is the super-admin's own report, not a shared default.
    Reading NULL as "platform, readable by all" holds for the settings singleton and
    is a platform-to-tenant disclosure here."""
    platform = await _job(world["db"], None, status="done", key="reports/platform-usage.csv")
    async with api_client(app) as c:
        got = await c.get(f"{REPORTS}/{platform.id}", headers=bearer(world["a"]))
        downloaded = await c.get(f"{REPORTS}/{platform.id}/download", headers=bearer(world["a"]))
        for_owner = await c.get(f"{REPORTS}/{platform.id}", headers=bearer(world["sa"]))
    assert got.status_code == 404, got.text
    assert downloaded.status_code == 404, downloaded.text
    # Reachable by whoever it belongs to, so the 404s above are isolation rather
    # than an unreadable row.
    assert for_owner.status_code == 200, for_owner.text


async def test_a_super_admin_sees_every_tenants_reports(app, world):
    """Without this, every assertion above passes against a build that shows nobody
    anything."""
    a = await _job(world["db"], world["ta"].id)
    b = await _job(world["db"], world["tb"].id)
    p = await _job(world["db"], None)

    async with api_client(app) as c:
        listed = await c.get(REPORTS, headers=bearer(world["sa"]))
        by_id = [
            await c.get(f"{REPORTS}/{j.id}", headers=bearer(world["sa"])) for j in (a, b, p)
        ]

    assert {j["id"] for j in listed.json()["items"]} == {str(a.id), str(b.id), str(p.id)}
    assert [r.status_code for r in by_id] == [200, 200, 200]


async def test_a_created_job_is_stamped_with_the_requesters_tenant(app, world):
    """The stamp is what every isolation assertion above rests on: an unstamped job
    is a NULL row, invisible to the tenant that asked for it."""
    async with api_client(app) as c:
        created = await c.post(
            REPORTS, headers=bearer(world["a"]), json={"name": "Q1", "format": "csv"}
        )
        mine = await c.get(REPORTS, headers=bearer(world["a"]))
        neighbour = await c.get(REPORTS, headers=bearer(world["b"]))

    job_id = created.json()["id"]
    assert [j["id"] for j in mine.json()["items"]] == [job_id]
    assert neighbour.json()["items"] == []


async def test_an_id_that_exists_nowhere_is_the_same_404_as_one_that_exists_elsewhere(app, world):
    """The refusal for a foreign row and the answer for a missing row must be
    indistinguishable, or the difference between them is the probe."""
    theirs = await _job(world["db"], world["tb"].id)
    async with api_client(app) as c:
        missing = await c.get(f"{REPORTS}/{uuid.uuid4()}", headers=bearer(world["a"]))
        foreign = await c.get(f"{REPORTS}/{theirs.id}", headers=bearer(world["a"]))
    assert missing.status_code == foreign.status_code == 404
    assert missing.json() == foreign.json()
