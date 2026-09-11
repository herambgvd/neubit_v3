"""Endpoint tests for the P6-D security API + the enforced-2FA login flow.

Spins up the full base app against the in-memory SQLite DB (get_db overridden),
authenticates real users, and drives the HTTP surface with httpx's ASGITransport —
no Docker/Postgres/network. Proves the routes are reachable, permission-gated, and
that the four-eyes + video-audit-ingest + config-CRUD + enforced-2FA flows work.
"""


import pytest

from conftest import api_client, bearer, make_role, make_user

pytestmark = pytest.mark.asyncio

PREFIX = "/api/v1"


async def test_policy_crud_gated(app, db):
    sec_role = await make_role(db, "SecAdmin", ["security.manage"])
    viewer_role = await make_role(db, "Viewer", ["vms.live.view"])
    admin = await make_user(db, "sec@x.io", sec_role)
    viewer = await make_user(db, "view@x.io", viewer_role)
    async with api_client(app) as c:
        # Viewer without security.manage is 403.
        r = await c.get(f"{PREFIX}/security/policy", headers=bearer(viewer))
        assert r.status_code == 403
        # Sec admin can read + update.
        r = await c.get(f"{PREFIX}/security/policy", headers=bearer(admin))
        assert r.status_code == 200 and r.json()["require_2fa"] is False
        r = await c.put(
            f"{PREFIX}/security/policy", headers=bearer(admin),
            json={"require_2fa": True, "require_2fa_roles": ["Ops"]},
        )
        assert r.status_code == 200 and r.json()["require_2fa"] is True


async def test_directory_and_sso_crud_hide_secrets(app, db):
    sec_role = await make_role(db, "SecAdmin", ["security.manage"])
    admin = await make_user(db, "sec@x.io", sec_role)
    async with api_client(app) as c:
        r = await c.put(
            f"{PREFIX}/security/directory", headers=bearer(admin),
            json={"server_uri": "ldaps://ad", "base_dn": "dc=c", "bind_dn": "cn=svc",
                  "bind_password": "secret", "group_role_map": {}},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["has_bind_password"] is True
        assert "bind_password" not in body  # secret never serialised out

        r = await c.put(
            f"{PREFIX}/security/sso", headers=bearer(admin),
            json={"issuer": "https://idp", "client_id": "cid", "client_secret": "csec"},
        )
        assert r.status_code == 200
        assert r.json()["has_client_secret"] is True
        assert "client_secret" not in r.json()


async def test_dual_auth_full_flow_over_http(app, db):
    req_role = await make_role(db, "Exporter", ["vms.export"])
    appr_role = await make_role(db, "Approver", ["dualauth.approve"])
    requester = await make_user(db, "req@x.io", req_role)
    approver = await make_user(db, "app@x.io", appr_role)
    async with api_client(app) as c:
        # 1. requester raises a four-eyes request
        r = await c.post(
            f"{PREFIX}/security/dual-auth", headers=bearer(requester),
            json={"action": "vms.export", "target_type": "camera", "target_id": "cam-1"},
        )
        assert r.status_code == 201
        req_id = r.json()["id"]
        assert r.json()["status"] == "pending"

        # 2. requester cannot approve their own (and lacks the perm anyway → 403)
        r = await c.post(f"{PREFIX}/security/dual-auth/{req_id}/approve",
                         headers=bearer(requester), json={})
        assert r.status_code == 403

        # 3. a different privileged user approves
        r = await c.post(f"{PREFIX}/security/dual-auth/{req_id}/approve",
                         headers=bearer(approver), json={"note": "ok"})
        assert r.status_code == 200 and r.json()["status"] == "approved"

        # 4. consume it right before the action; second consume fails
        r = await c.post(
            f"{PREFIX}/security/dual-auth/{req_id}/consume",
            headers=bearer(requester),
            params={"action": "vms.export", "target_id": "cam-1"},
        )
        assert r.status_code == 200 and r.json()["status"] == "consumed"
        r = await c.post(
            f"{PREFIX}/security/dual-auth/{req_id}/consume",
            headers=bearer(requester),
            params={"action": "vms.export", "target_id": "cam-1"},
        )
        assert r.status_code == 409  # already used


async def test_video_audit_ingest_writes_trail(app, db):
    # A service caller with audit.write ingests a playback event; it lands in the trail.
    svc_role = await make_role(db, "VisionService", ["audit.write"])
    audit_role = await make_role(db, "Auditor", ["audit.read"])
    svc_user = await make_user(db, "vision@svc.io", svc_role)
    auditor = await make_user(db, "audit@x.io", audit_role)
    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/security/audit/video", headers=bearer(svc_user),
            json={"action": "vms.playback", "target_type": "camera", "target_id": "cam-9",
                  "actor_email": "operator@x.io", "meta": {"range": "10:00-10:05"}},
        )
        assert r.status_code == 201
        # The auditor can see it in the audit log.
        r = await c.get(f"{PREFIX}/audit", headers=bearer(auditor))
        assert r.status_code == 200
        actions = [e["action"] for e in r.json()["items"]]
        assert "vms.playback" in actions


async def test_erasure_endpoint_scaffold(app, db):
    sec_role = await make_role(db, "SecAdmin", ["security.manage"])
    admin = await make_user(db, "sec@x.io", sec_role)
    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/security/erasure", headers=bearer(admin),
            json={"subject_type": "person", "subject_id": "p-42", "reason": "DPDP request"},
        )
        assert r.status_code == 202
        body = r.json()
        assert body["subject_id"] == "p-42"
        # NATS off in tests → recorded (not dispatched), but the audit trail has it.


async def test_enforced_2fa_login_blocks_then_enrolls(app, db):
    """Policy requires 2FA → login returns enrollment_required; enroll → tokens."""
    role = await make_role(db, "Ops", ["vms.export"])
    user = await make_user(db, "ops@x.io", role, password="Passw0rd!")
    # Enforce 2FA platform-wide via the service (user has none enrolled).
    from app.security.schemas import SecurityPolicyIn
    from app.security.service import SecurityService
    from app.tenancy.scope import scope_of

    await SecurityService(db).update_policy(scope_of(user), SecurityPolicyIn(require_2fa=True))

    async with api_client(app) as c:
        r = await c.post(f"{PREFIX}/auth/login", json={"email": "ops@x.io", "password": "Passw0rd!"})
        assert r.status_code == 200
        body = r.json()
        assert body["enrollment_required"] is True
        assert body["access_token"] is None
        assert body["mfa_token"]  # challenge token to authorize enrolment
        mfa_token = body["mfa_token"]

        # Begin enrolment with the challenge token, compute the first TOTP code.
        r = await c.post(f"{PREFIX}/auth/2fa/enroll/begin", json={"mfa_token": mfa_token, "code": ""})
        assert r.status_code == 200
        secret = r.json()["secret"]
        from app.auth.security import _hotp
        import time

        code = _hotp(secret, int(time.time() // 30))
        # Confirm enrolment → real tokens issued.
        r = await c.post(f"{PREFIX}/auth/2fa/enroll/confirm", json={"mfa_token": mfa_token, "code": code})
        assert r.status_code == 200, r.text
        assert r.json()["access_token"]


async def test_video_audit_ingest_accepts_a_service_token(app, db):
    """vision's SERVICE token must reach the ingest route, not 401 before it.

    Its `sub` is a reserved system UUID with no `users` row, and every base router
    is wrapped in `require_tenant_active`, which resolves an actor. That guard used
    to 401 the call before `require_service_permission` on the route was ever
    consulted — so the shipped service-to-service path was closed while the test
    above passed, because it authenticates a real user.
    """
    import time

    import jwt

    from app.core.config import get_settings

    now = int(time.time())
    token = jwt.encode(
        {"sub": "00000000-0000-0000-0000-0000000000ec", "type": "access",
         "tenant_id": None, "is_superadmin": True, "permissions": ["*"],
         "iat": now, "exp": now + 120},
        get_settings().jwt_secret, algorithm="HS256",
    )
    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/security/audit/video",
            headers={"Authorization": f"Bearer {token}"},
            json={"action": "vms.export", "target_type": "camera", "target_id": "cam-3"},
        )
    assert r.status_code == 201, r.text
