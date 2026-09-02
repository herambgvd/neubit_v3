"""Pytest config for the VMS driver tests.

NO live devices are touched — every network boundary is monkeypatched with fabricated
fixtures (SOAP objects mimicking python-onvif-zeep return shapes, ISAPI XML, Dahua CGI
text, Lumina JSON). ``pytest-asyncio`` in auto mode (``asyncio_mode = "auto"`` in
pyproject) runs the ``async def test_*`` coroutines — no per-test marker needed.
"""

from __future__ import annotations
