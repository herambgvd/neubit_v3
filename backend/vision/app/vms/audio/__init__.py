"""Two-way audio (talk-to-camera) control plane — G6.

Issues a short-lived TALK SESSION (the frontend's push-to-talk credential) for a
backchannel-capable camera. Mirrors the live-session issuer (``vms.live``): the
service resolves the camera's backchannel target via its driver, mints a distinct
``sub_type="talk"`` token, and returns what the browser needs to open an uplink
(mic → WHIP-into-MediaMTX / backchannel). The real on-wire push to a device speaker
is # LIVE-VALIDATE (brand-specific).

Audio RECORDING (retain the audio track) is NOT here — that is a flag on the camera
recording config (``audio_enabled``) wired through the recording control plane
(``vms.recording``) to the Go nvr.
"""

from .router import router as router

__all__ = ["router"]
