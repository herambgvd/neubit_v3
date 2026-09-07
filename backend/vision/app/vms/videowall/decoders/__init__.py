"""Hardware video-DECODER drivers — the video wall's display appliances (VW-B).

A decoder is a box on a wall that is HANDED an RTSP URL and told to show it. It is
not a camera and holds no footage, which is why these are the only brand drivers left
in this service: the wall is a VMS concept (it spans recorders, and a recorder has no
idea another one exists), so the thing that drives its displays belongs here.

They lived in ``app/vms/drivers`` beside the CAMERA drivers, which is what made that
package look like one thing. It was two: the camera half decrypted a camera's
credentials and drove the device, which is the recorder's job and is gone. Moving
these under ``videowall/`` is the rest of that separation — the name now says what
they drive.

Brands: Hikvision and Dahua/CP-Plus, over their HTTP control APIs (``_http``).
"""

from __future__ import annotations

from .decoder_base import DecoderCredentials, DecoderDriver
from .decoder_factory import get_decoder_driver

__all__ = ["DecoderCredentials", "DecoderDriver", "get_decoder_driver"]
