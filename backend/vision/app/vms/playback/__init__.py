"""VMS recorded-playback domain (P4-A).

The control-plane half of recorded playback (D8 plane split): vision issues a
recorded ``PlaybackSession`` (``kind="recorded"``) over a time-window and computes
the scrub-bar **timeline** (coverage + gaps) from ``Recording`` rows, while the Go
``nvr`` resolves the MediaMTX playback server URL. Self-contained
(``schemas`` + ``service`` + ``router``) like the other VMS domains.
"""

from __future__ import annotations
