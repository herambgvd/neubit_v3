"""Token round-trip for the ``role_id`` claim (Task 1: per-camera ACL subjects).

Core mints ``role_id`` into the access token; the kernel's ``verify_token`` reads
it back onto the Principal and exposes ``subjects()`` for role-subject ACL grants.
A legacy token (minted before the claim existed) must still decode with role_id=None.
"""

from __future__ import annotations

import datetime as dt

import jwt
import pytest

from app.auth.security import create_access_token, _encode
from app.core.config import get_settings

from kernel.auth import verify_token

from tests.conftest import make_role, make_user

pytestmark = pytest.mark.asyncio


async def test_token_carries_role_id_and_subjects(db):
    role = await make_role(db, "Operator-test", ["camera.view"])
    user = await make_user(db, "op@example.com", role)

    token = create_access_token(user)

    # Core minted the claim as a plain string id.
    payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    assert payload["role_id"] == str(role.id)

    # Kernel parses it onto the Principal + exposes both subjects.
    principal = verify_token(token)
    assert principal.role_id == str(role.id)
    assert principal.subjects() == [f"user:{user.id}", f"role:{role.id}"]


async def test_legacy_token_without_role_id_decodes(db):
    role = await make_role(db, "Operator-legacy", ["camera.view"])
    user = await make_user(db, "legacy@example.com", role)

    # Simulate a token minted BEFORE this change: no role_id claim at all.
    legacy = _encode(
        user.id,
        "access",
        dt.timedelta(minutes=5),
        extra={"tenant_id": None, "is_superadmin": False, "permissions": ["camera.view"]},
    )

    principal = verify_token(legacy)
    assert principal.role_id is None
    assert principal.subjects() == [f"user:{user.id}"]
