"""Reusable annotated field types shared by the API schemas."""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, EmailStr


def _plain_ascii_email(value: str) -> str:
    """Reject internationalized (SMTPUTF8) addresses — including emoji.

    ``EmailStr`` alone accepts them: pydantic delegates to email-validator, which
    allows a non-ASCII local part, so ``mohit😀@example.com`` validated and an
    account was created under an address no mail server here will deliver to. It
    also invites impersonation — an emoji-carrying variant of a real address looks
    identical at a glance in a user list.

    Whitespace around the value is trimmed (a pasted address often carries some);
    case is left alone, since existing rows are stored verbatim and sign-in matches
    the stored string exactly.
    """
    email = value.strip()
    if not email.isascii():
        raise ValueError("must not contain emoji or other non-ASCII characters")
    return email


# Use this instead of EmailStr for any address the platform will actually mail to
# or match on (accounts, invites, tenant admins).
AsciiEmail = Annotated[EmailStr, AfterValidator(_plain_ascii_email)]
