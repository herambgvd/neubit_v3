"""Unit tests for the P6-D SecurityService — the logic behind the endpoints.

Covers: 2FA-enforcement policy, LDAP sync + bind/mapping (FakeLdapClient), OIDC
token-exchange + provisioning (mock IdP), and the four-eyes dual-auth flow. No
network / Docker required — everything runs on the in-memory SQLite fixture.
"""

from __future__ import annotations

import uuid

import pytest

from app.core.secrets import decrypt_secret
from app.security.ldap_client import FakeLdapClient, LdapEntry
from app.security.models import DirectoryConfig, SsoConfig
from app.security.schemas import (
    DirectoryConfigIn,
    DualAuthDecisionIn,
    DualAuthRequestIn,
    SecurityPolicyIn,
    SsoConfigIn,
)
from app.security.service import SecurityService
from app.tenancy.scope import scope_of
from conftest import make_role, make_user

pytestmark = pytest.mark.asyncio


# --- 2FA enforcement ---------------------------------------------------------
async def test_policy_require_2fa_forces_enrollment(db, admin_role):
    admin = await make_user(db, "admin@x.io", admin_role, superadmin=True)
    svc = SecurityService(db)
    # No policy yet → not required.
    assert await svc.user_must_enroll_2fa(admin) is False
    # Turn on platform-wide 2FA enforcement.
    await svc.update_policy(scope_of(admin), SecurityPolicyIn(require_2fa=True))
    assert await svc.user_must_enroll_2fa(admin) is True
    # A user who already enrolled TOTP is exempt.
    admin.totp_enabled = True
    assert await svc.user_must_enroll_2fa(admin) is False


async def test_policy_require_2fa_role_narrowing(db):
    ops_role = await make_role(db, "Ops", ["vms.export"])
    viewer_role = await make_role(db, "Viewer", ["vms.live.view"])
    ops = await make_user(db, "ops@x.io", ops_role)
    viewer = await make_user(db, "view@x.io", viewer_role)
    svc = SecurityService(db)
    # Enforce 2FA only for the "Ops" role.
    await svc.update_policy(scope_of(ops), SecurityPolicyIn(require_2fa=True, require_2fa_roles=["Ops"]))
    assert await svc.user_must_enroll_2fa(ops) is True
    assert await svc.user_must_enroll_2fa(viewer) is False


# --- LDAP directory ----------------------------------------------------------
async def test_directory_config_encrypts_bind_password(db, admin_role):
    admin = await make_user(db, "admin@x.io", admin_role, superadmin=True)
    svc = SecurityService(db)
    cfg = await svc.upsert_directory(
        scope_of(admin),
        DirectoryConfigIn(
            server_uri="ldaps://ad.corp:636", base_dn="dc=corp,dc=io",
            bind_dn="cn=svc,dc=corp,dc=io", bind_password="s3cr3t",
            group_role_map={"cn=admins,dc=corp,dc=io": admin_role.name},
        ),
    )
    # Stored ciphertext is not the plaintext, but decrypts back to it.
    assert cfg.bind_password != "s3cr3t"
    assert decrypt_secret(cfg.bind_password) == "s3cr3t"


async def test_directory_sync_maps_groups_to_roles(db):
    ops_role = await make_role(db, "Ops", ["vms.export"])
    admin_role = await make_role(db, "Admin", ["*"])
    admin = await make_user(db, "admin@x.io", admin_role, superadmin=True)
    svc = SecurityService(db)
    await svc.upsert_directory(
        scope_of(admin),
        DirectoryConfigIn(
            server_uri="ldaps://ad.corp", base_dn="dc=corp",
            bind_dn="cn=svc", bind_password="pw",
            group_role_map={"cn=ops": "Ops"}, default_role=None,
        ),
    )
    fake = FakeLdapClient({
        "alice": ("pw1", LdapEntry(dn="cn=alice", email="alice@corp.io",
                                   display_name="Alice", groups=["cn=ops,dc=corp"])),
        "bob": ("pw2", LdapEntry(dn="cn=bob", email="bob@corp.io",
                                 display_name="Bob", groups=["cn=nobody"])),  # no mapping → skipped
    })
    result = await svc.sync_directory(scope_of(admin), client=fake)
    assert result.created == 1  # alice mapped to Ops
    assert result.skipped == 1  # bob has no group mapping
    assert result.live is False


async def test_ldap_authenticate_provisions_user(db):
    ops_role = await make_role(db, "Ops", ["vms.export"])
    admin_role = await make_role(db, "Admin", ["*"])
    admin = await make_user(db, "admin@x.io", admin_role, superadmin=True)
    svc = SecurityService(db)
    cfg = await svc.upsert_directory(
        scope_of(admin),
        DirectoryConfigIn(server_uri="ldaps://ad", base_dn="dc=c", bind_dn="cn=svc",
                          bind_password="pw", group_role_map={"cn=ops": "Ops"}),
    )
    fake = FakeLdapClient({
        "carol": ("carolpw", LdapEntry(dn="cn=carol", email="carol@corp.io",
                                       display_name="Carol", groups=["cn=ops"])),
    })
    user = await svc.ldap_authenticate(cfg, "carol", "carolpw", client=fake)
    assert user.email == "carol@corp.io"
    assert user.role_id == ops_role.id


# --- OIDC SSO ----------------------------------------------------------------
class _MockResp:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class _MockIdp:
    """A mock OIDC IdP: serves a discovery doc + a token response with an id_token."""

    def __init__(self, id_token: str):
        self.id_token = id_token

    async def get(self, url):
        return _MockResp({
            "authorization_endpoint": "https://idp/auth",
            "token_endpoint": "https://idp/token",
        })

    async def post(self, url, data):
        return _MockResp({"id_token": self.id_token, "access_token": "at"})


def _unsigned_jwt(claims: dict) -> str:
    import jwt

    return jwt.encode(claims, "unused", algorithm="HS256")


async def test_sso_exchange_provisions_and_maps_role(db):
    ops_role = await make_role(db, "Ops", ["vms.export"])
    admin_role = await make_role(db, "Admin", ["*"])
    admin = await make_user(db, "admin@x.io", admin_role, superadmin=True)
    svc = SecurityService(db)
    await svc.upsert_sso(
        scope_of(admin),
        SsoConfigIn(
            issuer="https://idp", client_id="cid", client_secret="csecret",
            groups_claim="groups", group_role_map={"ops": "Ops"}, default_role=None,
        ),
    )
    cfg = await svc.get_sso(scope_of(admin))
    id_token = _unsigned_jwt({"email": "dave@corp.io", "name": "Dave", "groups": ["ops"]})
    user = await svc.sso_exchange(cfg, code="authcode", http=_MockIdp(id_token))
    assert user.email == "dave@corp.io"
    assert user.role_id == ops_role.id
    # Secret is stored encrypted.
    assert decrypt_secret(cfg.client_secret) == "csecret"


async def test_sso_rejects_when_no_role_and_no_auto_provision(db):
    admin_role = await make_role(db, "Admin", ["*"])
    admin = await make_user(db, "admin@x.io", admin_role, superadmin=True)
    svc = SecurityService(db)
    await svc.upsert_sso(
        scope_of(admin),
        SsoConfigIn(issuer="https://idp", client_id="cid", auto_provision=False),
    )
    cfg = await svc.get_sso(scope_of(admin))
    id_token = _unsigned_jwt({"email": "eve@corp.io", "name": "Eve"})
    from app.core.errors import UnauthorizedError

    with pytest.raises(UnauthorizedError):
        await svc.sso_exchange(cfg, code="c", http=_MockIdp(id_token))


# --- Dual authorization (four-eyes) -----------------------------------------
async def test_dual_auth_approve_flow(db):
    approver_role = await make_role(db, "Approver", ["dualauth.approve"])
    requester_role = await make_role(db, "Requester", ["vms.export"])
    requester = await make_user(db, "req@x.io", requester_role)
    approver = await make_user(db, "app@x.io", approver_role)
    svc = SecurityService(db)
    req = await svc.create_dual_auth(
        requester,
        DualAuthRequestIn(action="vms.export", target_type="camera", target_id="cam-1"),
    )
    assert req.status == "pending"
    # A DIFFERENT privileged user approves.
    decided = await svc.decide_dual_auth(
        approver, scope_of(approver), req.id, approve=True, note="ok"
    )
    assert decided.status == "approved"
    # Consume it right before the action; a second consume fails.
    consumed = await svc.check_and_consume(scope_of(approver), "vms.export", "cam-1", req.id)
    assert consumed.status == "consumed"
    from app.core.errors import ConflictError

    with pytest.raises(ConflictError):
        await svc.check_and_consume(scope_of(approver), "vms.export", "cam-1", req.id)


async def test_dual_auth_self_approval_blocked(db):
    role = await make_role(db, "Both", ["vms.export", "dualauth.approve"])
    user = await make_user(db, "solo@x.io", role)
    svc = SecurityService(db)
    req = await svc.create_dual_auth(user, DualAuthRequestIn(action="vms.export"))
    from app.core.errors import ValidationError

    with pytest.raises(ValidationError):
        await svc.decide_dual_auth(user, scope_of(user), req.id, approve=True, note=None)


async def test_dual_auth_deny_blocks_consume(db):
    approver_role = await make_role(db, "Approver", ["dualauth.approve"])
    requester_role = await make_role(db, "Requester", ["vms.export"])
    requester = await make_user(db, "req@x.io", requester_role)
    approver = await make_user(db, "app@x.io", approver_role)
    svc = SecurityService(db)
    req = await svc.create_dual_auth(requester, DualAuthRequestIn(action="recording.delete", target_id="r1"))
    await svc.decide_dual_auth(approver, scope_of(approver), req.id, approve=False, note="no")
    from app.core.errors import UnauthorizedError

    with pytest.raises(UnauthorizedError):
        await svc.check_and_consume(scope_of(approver), "recording.delete", "r1", req.id)


async def test_dual_auth_action_mismatch_rejected(db):
    approver_role = await make_role(db, "Approver", ["dualauth.approve"])
    requester_role = await make_role(db, "Requester", ["vms.export"])
    requester = await make_user(db, "req@x.io", requester_role)
    approver = await make_user(db, "app@x.io", approver_role)
    svc = SecurityService(db)
    req = await svc.create_dual_auth(requester, DualAuthRequestIn(action="vms.export", target_id="cam-1"))
    await svc.decide_dual_auth(approver, scope_of(approver), req.id, approve=True, note=None)
    from app.core.errors import ValidationError

    with pytest.raises(ValidationError):
        # approval was for vms.export, not tenant.delete
        await svc.check_and_consume(scope_of(approver), "tenant.delete", "cam-1", req.id)
