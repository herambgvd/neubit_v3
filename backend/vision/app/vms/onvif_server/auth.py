"""WS-Security UsernameToken validation for the ONVIF SOAP server (P6-C).

Ported from gvd_nvr ``onvif_device/service._verify_username_token`` and made
MULTI-TENANT: instead of one process-wide device credential, the token's Username is
looked up against the enabled ``OnvifServerConfig`` rows — a match RESOLVES the tenant
whose cameras/recordings the request then sees. The stored password is reversibly
encrypted (``vms.common.crypto``), decrypted in-memory to validate a PasswordText or
PasswordDigest token.

Returns the matched ``OnvifServerConfig`` (→ its ``tenant_id`` scopes the response) or
``None`` (→ the caller emits a ``ter:NotAuthorized`` SOAP fault).
"""

from __future__ import annotations

import base64
import hashlib
import logging

from lxml import etree
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.vms.common.crypto import decrypt_secret
from app.vms.models import OnvifServerConfig

from .xml_utils import NS_SOAP, NS_WSSE, NS_WSU, _parse, _qn

log = logging.getLogger("vision.onvif_server.auth")


def _password_matches(pwd_text: str, pwd_type: str, nonce_el, created_el, secret: str) -> bool:
    """PasswordText → plain compare; PasswordDigest → SHA1(nonce+created+password)."""
    if "PasswordDigest" in (pwd_type or ""):
        if nonce_el is None or created_el is None:
            return False
        try:
            nonce_bytes = base64.b64decode(nonce_el.text or "")
        except Exception:  # noqa: BLE001
            return False
        created = created_el.text or ""
        expected = base64.b64encode(
            hashlib.sha1(nonce_bytes + created.encode() + secret.encode()).digest()
        ).decode()
        return pwd_text == expected
    # PasswordText (or unspecified) → plaintext compare.
    return pwd_text == secret


def _extract_username_token(xml_bytes: bytes):
    """(username, password_el, nonce_el, created_el) or None if no UsernameToken."""
    root = _parse(xml_bytes)
    if root is None:
        return None
    header = root.find(_qn(NS_SOAP, "Header"))
    if header is None:
        return None
    security = header.find(_qn(NS_WSSE, "Security"))
    if security is None:
        return None
    ut = security.find(_qn(NS_WSSE, "UsernameToken"))
    if ut is None:
        return None
    username_el = ut.find(_qn(NS_WSSE, "Username"))
    password_el = ut.find(_qn(NS_WSSE, "Password"))
    if username_el is None or password_el is None:
        return None
    nonce_el = ut.find(_qn(NS_WSSE, "Nonce"))
    created_el = ut.find(_qn(NS_WSU, "Created"))
    return (username_el.text or "", password_el, nonce_el, created_el)


async def authenticate(xml_bytes: bytes, db: AsyncSession) -> OnvifServerConfig | None:
    """Validate the WS-Security UsernameToken → the matching enabled config, else None.

    An absent/malformed security header, an unknown username, a disabled config, or a
    wrong password all return ``None`` (→ ``ter:NotAuthorized``). No credential is ever
    trusted without an enabled config row backing it — the server is closed by default.
    """
    parsed = _extract_username_token(xml_bytes)
    if parsed is None:
        return None
    username, password_el, nonce_el, created_el = parsed
    if not username:
        return None

    row = (
        await db.execute(
            select(OnvifServerConfig).where(
                OnvifServerConfig.service_username == username,
                OnvifServerConfig.enabled.is_(True),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        log.info("ONVIF auth: no enabled config for username %r", username)
        return None

    secret = decrypt_secret(row.service_enc_password)
    if not secret:
        log.info("ONVIF auth: config for %r has no usable password", username)
        return None

    pwd_text = password_el.text or ""
    pwd_type = password_el.get("Type", "")
    if _password_matches(pwd_text, pwd_type, nonce_el, created_el, secret):
        return row
    log.info("ONVIF auth: password mismatch for username %r", username)
    return None


def fault_response(code: str, reason: str) -> bytes:
    """A SOAP 1.2 Fault envelope (serialized bytes) — e.g. ``ter:NotAuthorized``."""
    from .xml_utils import serialize, soap_body, soap_envelope

    env = soap_envelope()
    body = soap_body(env)
    fault = etree.SubElement(body, _qn(NS_SOAP, "Fault"))
    code_el = etree.SubElement(fault, _qn(NS_SOAP, "Code"))
    val = etree.SubElement(code_el, _qn(NS_SOAP, "Value"))
    val.text = "soap:Sender"
    subcode = etree.SubElement(code_el, _qn(NS_SOAP, "Subcode"))
    sub_val = etree.SubElement(subcode, _qn(NS_SOAP, "Value"))
    sub_val.text = code
    reason_el = etree.SubElement(fault, _qn(NS_SOAP, "Reason"))
    text_el = etree.SubElement(reason_el, _qn(NS_SOAP, "Text"))
    text_el.set("{http://www.w3.org/XML/1998/namespace}lang", "en")
    text_el.text = reason
    return serialize(env)
