"""Where the VMS writes files an operator downloads.

Today that is scheduled REPORT artefacts and nothing else. It used to be clip
exports too — this helper lived in ``app.vms.export.worker`` and reports imported it
from there — but clip export moved to the recorder that owns the footage, which is
the only box that can cut it, hash it and sign a chain-of-custody manifest for it.
The helper outlived that module because a report is a VMS artefact: it aggregates
across recorders, so no single recorder could produce it.

The default still puts these under the recordings volume, so a deployment needs no
extra mount. It is a WRITE into a directory the recorder also uses, which is why it
is deliberately confined to a ``downloads/`` subtree and never the segment layout:
the recorder owns retention over its own segments, and a second process writing into
that layout is how two movers end up on one volume.
"""

from __future__ import annotations

import os


def downloads_dir() -> str:
    """Root of the downloads area (a subdirectory of the recordings volume by default).

    Defaults to ``<VE_RECORDINGS_DIR>/downloads``; override with ``VE_DOWNLOADS_DIR``
    for a dedicated volume.
    """
    explicit = os.getenv("VE_DOWNLOADS_DIR", "").strip()
    if explicit:
        return explicit.rstrip("/")
    rec = (os.getenv("VE_RECORDINGS_DIR", "").strip() or "/recordings").rstrip("/")
    return f"{rec}/downloads"


__all__ = ["downloads_dir"]
