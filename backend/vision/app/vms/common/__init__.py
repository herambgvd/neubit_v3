"""Shared building blocks for the VMS service (crypto, event bus, cross-domain schemas).

These are the pieces every domain package (cameras / nvr / groups) reuses:
  * ``crypto``  — reversible credential encryption (ONVIF / NVR passwords).
  * ``events``  — the process-wide NATS ``EventBus`` + emit helpers.
  * ``schemas`` — cross-domain status/type literals.
"""

from __future__ import annotations
