"""Which origins may make CREDENTIALED cross-origin calls.

`allow_credentials=True` is what makes this a security boundary rather than a
convenience setting. Whatever matches gets the browser's cookies attached to the
request AND gets the response echoed back to it — and `/api/v1/auth/refresh`
reads the httpOnly refresh cookie and returns a fresh access token in the body.

The default was `https?://.*`. Verified against the running stack before the fix:

    POST /api/v1/auth/refresh   Origin: https://evil.example
    -> access-control-allow-origin: https://evil.example
       access-control-allow-credentials: true

So any page an operator visited while signed in could take the session, with no
XSS and nothing to click.

The loose default existed so the app "opens from any machine on the LAN", and
that intent is kept: loopback, the three RFC 1918 ranges, `*.local`. What is gone
is the public internet.
"""


import re

import pytest

from app.core.config import Settings

RX = re.compile(Settings().cors_origin_regex)


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:3000",      # the dev frontend
        "http://localhost",           # through the gateway
        "https://localhost",
        "http://127.0.0.1:8000",
        "http://[::1]:3000",
        "http://192.168.1.20:3000",   # someone else's laptop on the LAN
        "http://10.0.0.5",
        "http://172.19.0.4:8000",     # the compose network
        "http://neubit.local",
    ],
)
def test_the_lan_still_opens_the_app(origin):
    """The reason the default was loose. Breaking this would be a different bug."""
    assert RX.fullmatch(origin), origin


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://evil.example",
        "https://neubit.example.com",
        "http://172.32.0.1",          # outside RFC 1918
        "http://11.0.0.1",            # ditto
        "https://localhost.evil.example",   # the suffix trick
        "https://evil.example/localhost",
        "http://x.local.evil.example",
        "null",
    ],
)
def test_the_public_internet_does_not(origin):
    assert not RX.fullmatch(origin), origin


def test_the_regex_is_anchored():
    """Starlette full-matches, but an unanchored pattern here would be a trap for
    whoever edits it next."""
    pattern = Settings().cors_origin_regex
    assert pattern.startswith("^") and pattern.endswith("$"), pattern


def test_the_kernel_agrees():
    """The six satellites mount the same middleware from the kernel's copy of this
    setting. A boundary that holds in core and not in access is not a boundary."""
    import os
    import pathlib
    import sys

    root = pathlib.Path(os.environ.get("VE_KERNEL_PATH") or "/src/kernel")
    if not (root / "kernel" / "config.py").is_file():
        root = pathlib.Path(__file__).resolve().parents[3] / "kernel"
    if not (root / "kernel" / "config.py").is_file():
        pytest.skip("kernel is not on this tree")
    sys.path.insert(0, str(root))
    try:
        from kernel.config import Settings as KernelSettings
    finally:
        sys.path.remove(str(root))

    assert KernelSettings().cors_origin_regex == Settings().cors_origin_regex, (
        "core and the kernel no longer share a CORS default"
    )
