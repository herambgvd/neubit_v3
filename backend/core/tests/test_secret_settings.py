"""Credentials stored as settings and as messaging config.

Two properties, on two surfaces. A setting the catalog flags `"secret": True` is
encrypted at rest and masked on the way out. And a write that carries the mask back
— which is what the UI submits after an unrelated edit — must keep the stored value
rather than encrypt `"***"` over it.
"""

from __future__ import annotations

import pytest

from app.settings import catalog
from app.settings.service import MASK, SettingsService

pytestmark = pytest.mark.asyncio


def test_the_catalog_declares_at_least_one_secret():
    """If nothing is flagged, every assertion below is vacuous."""
    assert catalog.secret_keys(), "no setting is marked secret — the tests below prove nothing"
    assert "google_maps_api_key" in catalog.secret_keys()


async def test_a_secret_setting_is_encrypted_at_rest(db):
    from sqlalchemy import select

    from app.settings.models import AppSetting

    svc = SettingsService(db, None)
    await svc.update({"google_maps_api_key": "AIzaSyREAL"})
    row = (
        await db.execute(select(AppSetting).where(AppSetting.key == "google_maps_api_key"))
    ).scalar_one()
    assert row.value != "AIzaSyREAL"
    assert str(row.value).startswith("enc:v1:")
    # …and round-trips for the one route that needs the real value.
    assert (await svc.all_values())["google_maps_api_key"] == "AIzaSyREAL"


async def test_the_settings_screen_never_sees_the_credential(db):
    svc = SettingsService(db, None)
    await svc.update({"google_maps_api_key": "AIzaSyREAL"})
    shown = await svc.display_values()
    assert shown["google_maps_api_key"] == MASK
    # A non-secret setting is untouched, so the mask is not just blanking everything.
    assert shown["google_maps_default_zoom"] == (await svc.all_values())["google_maps_default_zoom"]


async def test_saving_the_masked_value_back_does_not_destroy_the_secret(db):
    """The destructive round-trip: the UI is handed "***" and submits it back."""
    svc = SettingsService(db, None)
    await svc.update({"google_maps_api_key": "AIzaSyREAL"})
    await svc.update({"google_maps_api_key": MASK, "google_maps_default_zoom": 9})
    values = await svc.all_values()
    assert values["google_maps_api_key"] == "AIzaSyREAL"  # kept
    assert values["google_maps_default_zoom"] == 9  # the real edit landed


async def test_a_tenants_secret_setting_is_not_readable_by_another_tenant(db):
    """Per-tenant keys, on the settings rows."""
    import uuid

    from app.core.secrets import SecretDecryptionError, decrypt_secret_for
    from sqlalchemy import select

    from app.settings.models import AppSetting

    tenant_a, tenant_b = uuid.uuid4(), uuid.uuid4()
    await SettingsService(db, tenant_a).update({"google_maps_api_key": "A-KEY"})
    row = (
        await db.execute(
            select(AppSetting).where(
                AppSetting.key == "google_maps_api_key", AppSetting.tenant_id == tenant_a
            )
        )
    ).scalar_one()
    with pytest.raises(SecretDecryptionError):
        decrypt_secret_for(tenant_b, str(row.value))


# --- messaging channel config ------------------------------------------------


async def test_editing_a_channel_without_retyping_the_password_keeps_it(db):
    from app.messaging.config import get_config_decrypted, masked, upsert_channel

    await upsert_channel(
        db, "email", True, {"host": "smtp.acme.io", "port": 587, "password": "s3cret"}
    )
    assert (await get_config_decrypted(db, "email"))["password"] == "s3cret"

    # What the UI is handed…
    shown = masked((await get_config_decrypted(db, "email")), "email")
    assert shown["password"] == "***"
    # …and what it submits back after the operator changes only the port.
    shown["port"] = 2525
    await upsert_channel(db, "email", True, shown)

    fresh = await get_config_decrypted(db, "email")
    assert fresh["password"] == "s3cret", "the masked value overwrote the real password"
    assert fresh["port"] == 2525


async def test_a_real_password_change_still_lands(db):
    """The guard must not make the password unchangeable."""
    from app.messaging.config import get_config_decrypted, upsert_channel

    await upsert_channel(db, "email", True, {"host": "h", "password": "old"})
    await upsert_channel(db, "email", True, {"host": "h", "password": "new"})
    assert (await get_config_decrypted(db, "email"))["password"] == "new"


async def test_a_channel_password_is_encrypted_under_its_own_tenants_key(db):
    import uuid

    from sqlalchemy import select

    from app.core.secrets import SecretDecryptionError, decrypt_secret_for
    from app.messaging.config import upsert_channel
    from app.messaging.config import ChannelConfig

    tenant_a, tenant_b = uuid.uuid4(), uuid.uuid4()
    await upsert_channel(db, "email", True, {"host": "h", "password": "a-pass"}, tenant_a)
    row = (
        await db.execute(
            select(ChannelConfig).where(
                ChannelConfig.channel == "email", ChannelConfig.tenant_id == tenant_a
            )
        )
    ).scalar_one()
    stored = row.config["password"]
    assert stored != "a-pass" and str(stored).startswith("enc:v1:")
    assert decrypt_secret_for(tenant_a, stored) == "a-pass"
    with pytest.raises(SecretDecryptionError):
        decrypt_secret_for(tenant_b, stored)


# --- who a message actually goes through -------------------------------------
#
# A send that takes no tenant_id resolves the platform-default channel row, so a
# tenant's own SMTP config is stored and masked correctly and never used — its mail
# goes out through the platform's server, from the platform's address.


async def test_a_tenant_with_its_own_smtp_is_not_sent_through_the_platforms(db):
    import uuid

    from app.messaging.config import get_config_decrypted, upsert_channel

    tenant = uuid.uuid4()
    await upsert_channel(db, "email", True, {"host": "smtp.platform", "password": "p"}, None)
    await upsert_channel(db, "email", True, {"host": "smtp.tenant", "password": "t"}, tenant)

    assert (await get_config_decrypted(db, "email", tenant))["host"] == "smtp.tenant"
    assert (await get_config_decrypted(db, "email", None))["host"] == "smtp.platform"


async def test_a_tenant_without_its_own_channel_still_inherits_the_default(db):
    """The fallback is deliberate: it is what makes the platform default useful."""
    import uuid

    from app.messaging.config import get_config_decrypted, upsert_channel

    await upsert_channel(db, "email", True, {"host": "smtp.platform", "password": "p"}, None)
    assert (await get_config_decrypted(db, "email", uuid.uuid4()))["host"] == "smtp.platform"


async def test_the_test_button_does_not_fall_back_to_the_platform_webhook(db):
    """`get_channel_exact` exists for the surfaces where inheriting is wrong. On
    demand, a tenant admin with no webhook of their own would otherwise get the
    platform's webhook hit with a payload signed by the platform's secret."""
    import uuid

    from app.messaging.config import get_channel, get_channel_exact, upsert_channel

    await upsert_channel(db, "webhook", True, {"url": "https://platform.example/hook"}, None)
    stranger = uuid.uuid4()
    assert await get_channel_exact(db, "webhook", stranger) is None
    # …while an ordinary send still inherits it.
    assert await get_channel(db, "webhook", stranger) is not None


def test_a_webhook_url_is_not_logged_with_its_query_string():
    """Query-string bearer tokens are a common receiver pattern and SECRET_FIELDS
    does not cover the URL, so logging the full URL leaks the credential into logs.
    """
    from app.messaging.webhook import _loggable

    assert _loggable("https://hooks.example/x?token=s3cret") == "https://hooks.example/x"
    assert "s3cret" not in _loggable("https://hooks.example/x?token=s3cret")
    assert "hunter2" not in _loggable("https://user:hunter2@hooks.example/x")
    # The endpoint must stay identifiable: an operator debugging a failed delivery
    # needs to know which one failed.
    assert _loggable("https://hooks.example:8443/a/b") == "https://hooks.example:8443/a/b"
    assert _loggable("not a url at all") == "not a url at all"
