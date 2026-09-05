"""Channel credentials are unreadable at rest, and yesterday's rows still work.

``NotificationChannel.config`` held SMTP passwords, webhook bearer tokens, the FCM
service-account private key and the APNs signing key as plain JSON. Anyone with the
table, a replica or a nightly dump had every tenant's sending credentials. These
tests pin the three properties that fix has to hold at once, because getting any
two of them is easy and getting the third is where this usually goes wrong:

  1. a credential written today is CIPHERTEXT in the column and plaintext to the
     connector;
  2. a credential written BEFORE encryption existed is still readable -- the
     migration path is "read both", not "re-write the table";
  3. a credential never leaves through the API, and the redaction that makes that
     true cannot be PATCHed back over the real value.

WHY THE CRYPTO ITSELF IS NOT RE-TESTED HERE: it is ``kernel.secrets``, one
derivation for the platform. What is tested here is workflow's half -- the field
POLICY, and the three call sites that have to apply it.
"""

from __future__ import annotations

import uuid

from conftest import make_sqlite_session, run_async

from kernel.auth import Scope
from kernel.secrets import ENC_PREFIX, decrypt_fields, encrypt_fields
from app.workflow.notifications import schemas as S
from app.workflow.notifications.jobs import _resolve_channel_config
from app.workflow.notifications.models import Notification, NotificationChannel
from app.workflow.notifications.secrets import REDACTED, is_secret_path, restore_redacted
from app.workflow.notifications.service import NotificationService

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = "tester"
    id = "tester"


def _smtp_cfg(password="hunter2-smtp"):
    return {"host": "smtp.example.test", "port": 587, "use_tls": True,
            "username": "alerts@example.test", "password": password}


# ── the policy: what counts as a credential ──────────────────────────────────


def test_policy_separates_credentials_from_routing():
    secret = [("password",), ("smtp_password",), ("api_key",), ("access_token",),
              ("auth_key",), ("client_secret",), ("service_account_json",),
              ("service_account", "private_key"), ("headers", "Authorization"),
              ("headers", "X-Vendor-Token"), ("headers", "Api-Secret")]
    for path in secret:
        assert is_secret_path(path), f"{path} must be encrypted"

    # Identifiers and routing. Encrypting these buys nothing and costs every
    # operator who has to read a channel to work out where it is sending.
    plain = [("host",), ("smtp_host",), ("port",), ("url",), ("use_tls",),
             ("from_address",), ("username",), ("timeout",), ("project_id",),
             ("key_id",), ("team_id",), ("topic",), ("bundle_id",),
             ("service_account", "private_key_id"), ("service_account", "client_email"),
             ("auth_key_file",), ("service_account_file",),
             ("headers", "Content-Type"), ("headers", "X-Request-Id")]
    for path in plain:
        assert not is_secret_path(path), f"{path} must stay readable"


def test_nested_and_header_values_survive_a_round_trip():
    cfg = {"url": "https://hooks.example.test/x",
           "headers": {"Content-Type": "application/json", "Authorization": "Bearer live-token"},
           "service_account": {"project_id": "p1", "private_key": "-----BEGIN PRIVATE KEY-----"}}
    enc = encrypt_fields(TENANT, cfg, is_secret_path)
    assert enc["url"] == cfg["url"]
    assert enc["headers"]["Content-Type"] == "application/json"
    assert enc["headers"]["Authorization"].startswith(ENC_PREFIX)
    assert enc["service_account"]["project_id"] == "p1"
    assert enc["service_account"]["private_key"].startswith(ENC_PREFIX)
    assert decrypt_fields(TENANT, enc, is_secret_path) == cfg


def test_a_tenants_key_does_not_open_another_tenants_row():
    enc = encrypt_fields(TENANT, _smtp_cfg(), is_secret_path)
    try:
        wrong = decrypt_fields(OTHER_TENANT, enc, is_secret_path)
    except Exception:
        return  # raising is the correct answer too
    assert wrong["password"] != "hunter2-smtp"


# ── the three call sites ─────────────────────────────────────────────────────


def test_create_stores_ciphertext_and_dispatch_reads_it_back():
    async def go():
        engine, sm = await make_sqlite_session(
            NotificationChannel.__table__, Notification.__table__)
        async with sm() as db:
            svc = NotificationService(db, Scope(tenant_id=TENANT, is_superadmin=False))
            row = await svc.create_channel(
                S.CreateChannelRequest(name="smtp", channel_type="email", config=_smtp_cfg()),
                actor=_Actor())
            # What is IN the column.
            assert row.config["password"].startswith(ENC_PREFIX)
            assert "hunter2-smtp" not in str(row.config)
            assert row.config["host"] == "smtp.example.test"  # routing stays readable

            # What the connector receives.
            note = Notification(tenant_id=TENANT, channel_type="email",
                                recipient="a@example.test", body="b", status="pending")
            db.add(note)
            await db.commit()
            cfg = await _resolve_channel_config(db, note)
            assert cfg["password"] == "hunter2-smtp"
        await engine.dispose()
    run_async(go())


def test_a_legacy_plaintext_row_still_dispatches():
    """The row this feature will actually meet on upgrade: written before encryption."""
    async def go():
        engine, sm = await make_sqlite_session(
            NotificationChannel.__table__, Notification.__table__)
        async with sm() as db:
            legacy = NotificationChannel(  # straight into the column, no encryption
                tenant_id=TENANT, name="legacy smtp", channel_type="email",
                config=_smtp_cfg("legacy-plaintext-pw"), is_enabled=True)
            db.add(legacy)
            note = Notification(tenant_id=TENANT, channel_type="email",
                                recipient="a@example.test", body="b", status="pending")
            db.add(note)
            await db.commit()
            assert legacy.config["password"] == "legacy-plaintext-pw"  # no marker
            cfg = await _resolve_channel_config(db, note)
            assert cfg["password"] == "legacy-plaintext-pw"
        await engine.dispose()
    run_async(go())


def test_the_api_response_carries_routing_but_no_credential():
    async def go():
        engine, sm = await make_sqlite_session(
            NotificationChannel.__table__, Notification.__table__)
        async with sm() as db:
            svc = NotificationService(db, Scope(tenant_id=TENANT, is_superadmin=False))
            row = await svc.create_channel(
                S.CreateChannelRequest(name="smtp", channel_type="email", config=_smtp_cfg()),
                actor=_Actor())
            body = S.ChannelPublic.from_row(row).model_dump_json()
            assert "hunter2-smtp" not in body
            assert ENC_PREFIX not in body        # nor the ciphertext, which is still the secret
            assert "smtp.example.test" in body   # but the operator can still see where it sends
        await engine.dispose()
    run_async(go())


def test_patching_the_redacted_marker_back_does_not_destroy_the_password():
    """The UI round-trip that silently deletes a credential if nobody thinks about it."""
    async def go():
        engine, sm = await make_sqlite_session(
            NotificationChannel.__table__, Notification.__table__)
        async with sm() as db:
            svc = NotificationService(db, Scope(tenant_id=TENANT, is_superadmin=False))
            row = await svc.create_channel(
                S.CreateChannelRequest(name="smtp", channel_type="email", config=_smtp_cfg()),
                actor=_Actor())
            shown = S.ChannelPublic.from_row(row).config
            assert shown["password"] == REDACTED
            shown["host"] = "smtp2.example.test"          # operator edits the host
            await svc.update_channel(row.channel_id,
                                     S.UpdateChannelRequest(config=shown), actor=_Actor())
            note = Notification(tenant_id=TENANT, channel_type="email",
                                recipient="a@example.test", body="b", status="pending")
            db.add(note)
            await db.commit()
            cfg = await _resolve_channel_config(db, note)
            assert cfg["host"] == "smtp2.example.test"
            assert cfg["password"] == "hunter2-smtp"      # not "********"
        await engine.dispose()
    run_async(go())


def test_a_real_new_secret_still_replaces_the_old_one():
    """restore_redacted must only fire on the marker, never swallow a real rotation."""
    stored = encrypt_fields(TENANT, _smtp_cfg(), is_secret_path)
    merged = restore_redacted({"host": "h", "password": "brand-new-pw"}, stored)
    assert merged["password"] == "brand-new-pw"
