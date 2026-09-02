"""The ONVIF SOAP server — OUR VMS answering as an ONVIF device (P6-C).

Ported from gvd_nvr ``onvif_device/`` (device_mgmt + media1 + recording + search +
replay handlers) and adapted to the v3 tenant-scoped VMS:

  * MULTI-TENANT: the WS-Security UsernameToken resolves an ``OnvifServerConfig`` →
    the request only ever sees that tenant's EXPOSED cameras + their recordings.
  * URLs point at OUR media: ``GetStreamUri`` → the MediaMTX RTSP URL, ``GetSnapshotUri``
    → our snapshot endpoint, Profile-G ``GetReplayUri`` → the recorded-playback URL.

Services answered (mounted at ``/onvif/<service>``):
  * **device**   — GetDeviceInformation, GetCapabilities, GetServices,
                   GetServiceCapabilities, GetSystemDateAndTime, GetScopes, GetHostname,
                   GetNetworkInterfaces, GetUsers.
  * **media**    — GetProfiles, GetProfile, GetStreamUri, GetSnapshotUri, GetVideoSources,
                   GetVideoSourceConfigurations, GetVideoEncoderConfigurations.
  * **media2**   — GetProfiles, GetStreamUri, GetSnapshotUri (Profile-T, ver20 ns).
  * **recording**— GetRecordings, GetRecordingSummary (Profile-G).
  * **search**   — FindRecordings, GetRecordingSearchResults, EndSearch, GetServiceCapabilities.
  * **replay**   — GetReplayUri, GetServiceCapabilities.

DEFERRED (documented): PTZ / Imaging control, ONVIF Events PullPoint push, GetRecordingJobs
write ops, audio profiles. External VMS pull of live + recorded video is fully covered.

Every operation is READ-ONLY over our data + graceful: an unknown action returns an empty
``<Action>Response`` (ONVIF clients tolerate this), never a 500.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from lxml import etree
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.config import get_settings

from app.vms.models import Camera, MediaProfile, OnvifServerConfig, Recording

from . import urls
from .xml_utils import (
    NS_TDS,
    NS_TR2,
    NS_TRC,
    NS_TRP,
    NS_TRT,
    NS_TSE,
    NS_TT,
    _qn,
    add_text,
    extract_profile_token,
    extract_recording_token,
    extract_time_range,
    parse_resolution,
    serialize,
    soap_body,
    soap_envelope,
)

log = logging.getLogger("vision.onvif_server.soap")

# Service-path → the ONVIF service key the dispatcher routes on.
SERVICE_PATHS = [
    "device_service",
    "media_service",
    "media2_service",
    "recording_service",
    "search_service",
    "replay_service",
]

# In-memory FindRecordings search-token registry (recording searches complete
# synchronously, but the two-step Find→GetResults contract needs a token to bounce).
_search_tokens: dict[str, dict] = {}


# ── tokens ↔ ids ────────────────────────────────────────────────────────────
def _profile_token(camera_id: str, profile: str = "main") -> str:
    return f"profile_{camera_id}__{profile}"


def _split_profile_token(token: str | None) -> tuple[str | None, str]:
    """``profile_<cam>__<profile>`` → (camera_id, profile). Legacy ``profile_<cam>`` ok."""
    if not token:
        return None, "main"
    body = token[len("profile_"):] if token.startswith("profile_") else token
    if "__" in body:
        cam, _, prof = body.partition("__")
        return cam, (prof or "main")
    return body, "main"


def _recording_token(camera_id: str) -> str:
    return f"rec_{camera_id}"


def _recording_token_to_camera(token: str | None) -> str | None:
    if not token:
        return None
    return token[len("rec_"):] if token.startswith("rec_") else token


# ── data access (tenant-scoped to the config's tenant + exposed set) ──────────
async def _exposed_cameras(db: AsyncSession, config: OnvifServerConfig) -> list[Camera]:
    stmt = select(Camera).where(Camera.is_enabled.is_(True))
    if config.tenant_id is not None:
        stmt = stmt.where(Camera.tenant_id == config.tenant_id)
    rows = list((await db.execute(stmt)).scalars().all())
    exposed = list(config.exposed_camera_ids or ["*"])
    if "*" in exposed:
        return rows
    allow = set(exposed)
    return [c for c in rows if c.id in allow]


async def _camera_if_exposed(
    db: AsyncSession, config: OnvifServerConfig, camera_id: str | None
) -> Camera | None:
    if not camera_id:
        return None
    cam = await db.get(Camera, camera_id)
    if cam is None or not cam.is_enabled:
        return None
    if config.tenant_id is not None and cam.tenant_id != config.tenant_id:
        return None
    exposed = list(config.exposed_camera_ids or ["*"])
    if "*" not in exposed and cam.id not in set(exposed):
        return None
    return cam


async def _profiles_for(db: AsyncSession, camera_id: str) -> list[MediaProfile]:
    return list(
        (
            await db.execute(
                select(MediaProfile).where(MediaProfile.camera_id == camera_id)
            )
        )
        .scalars()
        .all()
    )


async def _recordings_for(
    db: AsyncSession, camera_id: str, start=None, end=None, limit: int = 100
) -> list[Recording]:
    stmt = select(Recording).where(Recording.camera_id == camera_id)
    if start:
        stmt = stmt.where(Recording.start_time >= start)
    if end:
        stmt = stmt.where(Recording.start_time <= end)
    stmt = stmt.order_by(Recording.start_time.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


# ── request context (host/scheme resolution) ─────────────────────────────────
class _Ctx:
    def __init__(self, config, headers, url_hostname, scheme, body_bytes):
        self.config = config
        self.headers = headers
        self.url_hostname = url_hostname
        self.scheme = scheme
        self.body = body_bytes


# ── device_service ────────────────────────────────────────────────────────────
async def _device(action: str, body: etree.Element, db, ctx: _Ctx):
    base = urls.http_base(ctx.config, ctx.headers, ctx.url_hostname, ctx.scheme)

    if "GetDeviceInformation" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetDeviceInformationResponse"))
        add_text(resp, NS_TDS, "Manufacturer", "Neubit")
        add_text(resp, NS_TDS, "Model", "Neubit VMS")
        add_text(resp, NS_TDS, "FirmwareVersion", _firmware())
        serial = f"NBVMS-{(str(ctx.config.tenant_id) if ctx.config.tenant_id else 'platform')[:8]}"
        add_text(resp, NS_TDS, "SerialNumber", serial)
        add_text(resp, NS_TDS, "HardwareId", "Neubit-VMS-ONVIF")

    elif "GetServices" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetServicesResponse"))
        for ns, path, major, minor in (
            (NS_TDS, "device_service", 2, 5),
            (NS_TRT, "media_service", 2, 6),
            (NS_TR2, "media2_service", 2, 0),
            (NS_TRC, "recording_service", 2, 0),
            (NS_TSE, "search_service", 2, 0),
            (NS_TRP, "replay_service", 1, 0),
        ):
            svc = etree.SubElement(resp, _qn(NS_TDS, "Service"))
            add_text(svc, NS_TDS, "Namespace", ns)
            add_text(svc, NS_TDS, "XAddr", f"{base}/onvif/{path}")
            ver = etree.SubElement(svc, _qn(NS_TDS, "Version"))
            add_text(ver, NS_TT, "Major", major)
            add_text(ver, NS_TT, "Minor", minor)

    elif "GetCapabilities" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetCapabilitiesResponse"))
        caps = etree.SubElement(resp, _qn(NS_TDS, "Capabilities"))
        dev = etree.SubElement(caps, _qn(NS_TT, "Device"))
        add_text(dev, NS_TT, "XAddr", f"{base}/onvif/device_service")
        media = etree.SubElement(caps, _qn(NS_TT, "Media"))
        add_text(media, NS_TT, "XAddr", f"{base}/onvif/media_service")
        sc = etree.SubElement(media, _qn(NS_TT, "StreamingCapabilities"))
        sc.set("RTPMulticast", "false")
        sc.set("RTP_TCP", "true")
        sc.set("RTP_RTSP_TCP", "true")
        ext = etree.SubElement(caps, _qn(NS_TT, "Extension"))
        rec = etree.SubElement(ext, _qn(NS_TT, "Recording"))
        add_text(rec, NS_TT, "XAddr", f"{base}/onvif/recording_service")
        srch = etree.SubElement(ext, _qn(NS_TT, "Search"))
        add_text(srch, NS_TT, "XAddr", f"{base}/onvif/search_service")
        rep = etree.SubElement(ext, _qn(NS_TT, "Replay"))
        add_text(rep, NS_TT, "XAddr", f"{base}/onvif/replay_service")
        m2 = etree.SubElement(ext, _qn(NS_TT, "Media"))
        add_text(m2, NS_TT, "XAddr", f"{base}/onvif/media2_service")

    elif "GetServiceCapabilities" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetServiceCapabilitiesResponse"))
        caps = etree.SubElement(resp, _qn(NS_TDS, "Capabilities"))
        sec = etree.SubElement(caps, _qn(NS_TDS, "Security"))
        sec.set("UsernameToken", "true")
        sec.set("HttpDigest", "false")

    elif "GetSystemDateAndTime" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetSystemDateAndTimeResponse"))
        now = datetime.now(timezone.utc)
        sdt = etree.SubElement(resp, _qn(NS_TDS, "SystemDateAndTime"))
        add_text(sdt, NS_TT, "DateTimeType", "NTP")
        add_text(sdt, NS_TT, "DaylightSavings", "false")
        tz = etree.SubElement(sdt, _qn(NS_TT, "TimeZone"))
        add_text(tz, NS_TT, "TZ", "UTC+0")
        utc = etree.SubElement(sdt, _qn(NS_TT, "UTCDateTime"))
        d = etree.SubElement(utc, _qn(NS_TT, "Date"))
        add_text(d, NS_TT, "Year", now.year)
        add_text(d, NS_TT, "Month", now.month)
        add_text(d, NS_TT, "Day", now.day)
        t = etree.SubElement(utc, _qn(NS_TT, "Time"))
        add_text(t, NS_TT, "Hour", now.hour)
        add_text(t, NS_TT, "Minute", now.minute)
        add_text(t, NS_TT, "Second", now.second)

    elif "GetScopes" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetScopesResponse"))
        for kind, item in _scopes(ctx.config):
            scope = etree.SubElement(resp, _qn(NS_TDS, "Scopes"))
            add_text(scope, NS_TT, "ScopeDef", kind)
            add_text(scope, NS_TT, "ScopeItem", item)

    elif "GetHostname" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetHostnameResponse"))
        info = etree.SubElement(resp, _qn(NS_TDS, "HostnameInformation"))
        add_text(info, NS_TT, "FromDHCP", "false")
        add_text(info, NS_TT, "Name",
                 urls.request_host(ctx.headers, ctx.url_hostname))

    elif "GetNetworkInterfaces" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetNetworkInterfacesResponse"))
        iface = etree.SubElement(resp, _qn(NS_TDS, "NetworkInterfaces"))
        iface.set("token", "eth0")
        add_text(iface, NS_TT, "Enabled", "true")

    elif "GetUsers" in action:
        resp = etree.SubElement(body, _qn(NS_TDS, "GetUsersResponse"))
        user = etree.SubElement(resp, _qn(NS_TDS, "User"))
        add_text(user, NS_TT, "Username", ctx.config.service_username)
        add_text(user, NS_TT, "UserLevel", "Administrator")

    else:
        _empty(body, NS_TDS, action)


# ── media_service (Profile S) + media2_service (Profile T) ────────────────────
async def _media(action: str, body: etree.Element, db, ctx: _Ctx, *, ns: str):
    resp_ns = ns

    if "GetProfiles" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetProfilesResponse"))
        for cam in await _exposed_cameras(db, ctx.config):
            profs = await _profiles_for(db, cam.id)
            names = [p.name for p in profs] or ["main"]
            for pname in names:
                mp = next((p for p in profs if p.name == pname), None)
                _build_profile(resp, cam, pname, mp, ns)

    elif "GetProfile" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetProfileResponse"))
        cam_id, pname = _split_profile_token(extract_profile_token(ctx.body))
        cam = await _camera_if_exposed(db, ctx.config, cam_id)
        if cam is not None:
            mp = next(
                (p for p in await _profiles_for(db, cam.id) if p.name == pname), None
            )
            _build_profile(resp, cam, pname, mp, ns)

    elif "GetStreamUri" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetStreamUriResponse"))
        cam_id, pname = _split_profile_token(extract_profile_token(ctx.body))
        cam = await _camera_if_exposed(db, ctx.config, cam_id)
        uri = ""
        if cam is not None:
            uri = urls.rtsp_stream_uri(
                ctx.config, ctx.headers, ctx.url_hostname,
                tenant=cam.tenant_id, camera_id=cam.id, profile=pname,
            )
        _media_uri(resp, uri, ns)

    elif "GetSnapshotUri" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetSnapshotUriResponse"))
        cam_id, _pname = _split_profile_token(extract_profile_token(ctx.body))
        cam = await _camera_if_exposed(db, ctx.config, cam_id)
        uri = ""
        if cam is not None:
            uri = urls.snapshot_uri(
                ctx.config, ctx.headers, ctx.url_hostname, ctx.scheme, cam.id
            )
        _media_uri(resp, uri, ns)

    elif "GetVideoSources" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetVideoSourcesResponse"))
        for cam in await _exposed_cameras(db, ctx.config):
            vs = etree.SubElement(resp, _qn(NS_TT, "VideoSources"))
            vs.set("token", f"vs_{cam.id}")
            profs = await _profiles_for(db, cam.id)
            w, h = parse_resolution(profs[0].resolution if profs else None)
            res = etree.SubElement(vs, _qn(NS_TT, "Resolution"))
            add_text(res, NS_TT, "Width", w)
            add_text(res, NS_TT, "Height", h)
            add_text(vs, NS_TT, "Framerate", (profs[0].fps if profs else None) or 25)

    elif "GetVideoSourceConfigurations" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetVideoSourceConfigurationsResponse"))
        for cam in await _exposed_cameras(db, ctx.config):
            _video_source_config(resp, cam, await _profiles_for(db, cam.id))

    elif "GetVideoEncoderConfigurations" in action:
        resp = etree.SubElement(body, _qn(resp_ns, "GetVideoEncoderConfigurationsResponse"))
        for cam in await _exposed_cameras(db, ctx.config):
            for mp in (await _profiles_for(db, cam.id)) or [None]:
                _video_encoder_config(resp, cam, mp)

    else:
        _empty(body, resp_ns, action)


# ── recording_service (Profile G) ─────────────────────────────────────────────
async def _recording(action: str, body: etree.Element, db, ctx: _Ctx):
    if "GetRecordings" in action:
        resp = etree.SubElement(body, _qn(NS_TRC, "GetRecordingsResponse"))
        for cam in await _exposed_cameras(db, ctx.config):
            recs = await _recordings_for(db, cam.id, limit=1000)
            item = etree.SubElement(resp, _qn(NS_TRC, "RecordingItem"))
            add_text(item, NS_TT, "RecordingToken", _recording_token(cam.id))
            src = etree.SubElement(item, _qn(NS_TT, "Source"))
            add_text(src, NS_TT, "SourceId", cam.id)
            add_text(src, NS_TT, "Name", cam.name)
            add_text(src, NS_TT, "Location", cam.site_id or "")
            add_text(src, NS_TT, "Description", cam.name)
            add_text(src, NS_TT, "Address", "")
            data_from, data_to = _recording_span(recs)
            tracks = etree.SubElement(item, _qn(NS_TT, "Tracks"))
            track = etree.SubElement(tracks, _qn(NS_TT, "Track"))
            add_text(track, NS_TT, "TrackToken", f"track_{cam.id}")
            add_text(track, NS_TT, "TrackType", "Video")
            add_text(track, NS_TT, "Description", cam.name)
            add_text(track, NS_TT, "DataFrom", data_from)
            add_text(track, NS_TT, "DataTo", data_to)

    elif "GetRecordingSummary" in action:
        resp = etree.SubElement(body, _qn(NS_TRC, "GetRecordingSummaryResponse"))
        cams = await _exposed_cameras(db, ctx.config)
        earliest = latest = None
        for cam in cams:
            recs = await _recordings_for(db, cam.id, limit=1000)
            if recs:
                lo = min(r.start_time for r in recs)
                hi = max((r.end_time or r.start_time) for r in recs)
                earliest = lo if earliest is None else min(earliest, lo)
                latest = hi if latest is None else max(latest, hi)
        summary = etree.SubElement(resp, _qn(NS_TRC, "Summary"))
        add_text(summary, NS_TT, "DataFrom", _iso(earliest) or _epoch())
        add_text(summary, NS_TT, "DataUntil", _iso(latest) or _now_iso())
        add_text(summary, NS_TT, "NumberRecordings", len(cams))

    else:
        _empty(body, NS_TRC, action)


# ── search_service (Profile G) ────────────────────────────────────────────────
async def _search(action: str, body: etree.Element, db, ctx: _Ctx):
    if "FindRecordings" in action:
        resp = etree.SubElement(body, _qn(NS_TSE, "FindRecordingsResponse"))
        token = f"search_{uuid.uuid4().hex[:12]}"
        _search_tokens[token] = {"created": datetime.now(timezone.utc)}
        add_text(resp, NS_TSE, "SearchToken", token)

    elif "GetRecordingSearchResults" in action:
        resp = etree.SubElement(body, _qn(NS_TSE, "GetRecordingSearchResultsResponse"))
        rec_token = extract_recording_token(ctx.body)
        start, end = extract_time_range(ctx.body)
        result_list = etree.SubElement(resp, _qn(NS_TSE, "ResultList"))
        add_text(result_list, NS_TSE, "SearchState", "Completed")
        want_cam = _recording_token_to_camera(rec_token)
        for cam in await _exposed_cameras(db, ctx.config):
            if want_cam and cam.id != want_cam:
                continue
            recs = await _recordings_for(db, cam.id, start, end, limit=1000)
            if not recs:
                continue
            info = etree.SubElement(result_list, _qn(NS_TT, "RecordingInformation"))
            add_text(info, NS_TT, "RecordingToken", _recording_token(cam.id))
            src = etree.SubElement(info, _qn(NS_TT, "Source"))
            add_text(src, NS_TT, "SourceId", cam.id)
            add_text(src, NS_TT, "Name", cam.name)
            add_text(src, NS_TT, "Description", cam.name)
            data_from, data_to = _recording_span(recs)
            add_text(info, NS_TT, "EarliestRecording", data_from)
            add_text(info, NS_TT, "LatestRecording", data_to)
            add_text(info, NS_TT, "Content", "")
            add_text(info, NS_TT, "RecordingStatus", "Stopped")

    elif "EndSearch" in action:
        etree.SubElement(body, _qn(NS_TSE, "EndSearchResponse"))
        from .xml_utils import extract_field

        _search_tokens.pop(extract_field(ctx.body, "SearchToken") or "", None)

    elif "GetServiceCapabilities" in action:
        resp = etree.SubElement(body, _qn(NS_TSE, "GetServiceCapabilitiesResponse"))
        caps = etree.SubElement(resp, _qn(NS_TSE, "Capabilities"))
        caps.set("MetadataSearch", "false")

    else:
        _empty(body, NS_TSE, action)


# ── replay_service (Profile G recorded pull) ──────────────────────────────────
async def _replay(action: str, body: etree.Element, db, ctx: _Ctx):
    if "GetReplayUri" in action:
        rec_token = extract_recording_token(ctx.body)
        start, _end = extract_time_range(ctx.body)
        cam_id = _recording_token_to_camera(rec_token)
        cam = await _camera_if_exposed(db, ctx.config, cam_id)
        uri = ""
        if cam is not None:
            # Resolve the segment covering ``start`` (else the latest) → derive the
            # profile + duration for the recorded-playback URL.
            seg = await _segment_at(db, cam.id, start)
            profile = seg.profile if seg else "main"
            start_iso = _iso(start) or (_iso(seg.start_time) if seg else None)
            duration = (seg.duration if seg else None) or 3600
            uri = urls.replay_uri(
                ctx.config, ctx.headers, ctx.url_hostname, ctx.scheme,
                tenant=cam.tenant_id, camera_id=cam.id, profile=profile,
                start_iso=start_iso, duration_s=duration,
            )
        resp = etree.SubElement(body, _qn(NS_TRP, "GetReplayUriResponse"))
        add_text(resp, NS_TRP, "Uri", uri)

    elif "GetServiceCapabilities" in action:
        resp = etree.SubElement(body, _qn(NS_TRP, "GetServiceCapabilitiesResponse"))
        caps = etree.SubElement(resp, _qn(NS_TRP, "Capabilities"))
        caps.set("ReversePlayback", "false")
        caps.set("SessionTimeoutRange", "1 300")

    else:
        _empty(body, NS_TRP, action)


# ── builders / helpers ────────────────────────────────────────────────────────
def _build_profile(parent, cam, pname, mp, ns):
    prof = etree.SubElement(parent, _qn(ns, "Profiles" if ns != NS_TR2 else "Profiles"))
    prof.set("token", _profile_token(cam.id, pname))
    prof.set("fixed", "false")
    add_text(prof, NS_TT, "Name", f"{cam.name} ({pname})")
    _video_source_config(prof, cam, [mp] if mp else [])
    _video_encoder_config(prof, cam, mp)


def _video_source_config(parent, cam, profs):
    vsc = etree.SubElement(parent, _qn(NS_TT, "VideoSourceConfiguration"))
    vsc.set("token", f"vsc_{cam.id}")
    add_text(vsc, NS_TT, "Name", f"VideoSource {cam.name}")
    add_text(vsc, NS_TT, "UseCount", "1")
    add_text(vsc, NS_TT, "SourceToken", f"vs_{cam.id}")
    w, h = parse_resolution(profs[0].resolution if profs and profs[0] else None)
    bounds = etree.SubElement(vsc, _qn(NS_TT, "Bounds"))
    bounds.set("x", "0")
    bounds.set("y", "0")
    bounds.set("width", str(w))
    bounds.set("height", str(h))


def _video_encoder_config(parent, cam, mp):
    cfg = etree.SubElement(parent, _qn(NS_TT, "VideoEncoderConfiguration"))
    cfg.set("token", f"vec_{cam.id}_{(mp.name if mp else 'main')}")
    add_text(cfg, NS_TT, "Name", f"Encoder {cam.name}")
    add_text(cfg, NS_TT, "UseCount", "1")
    codec = ((mp.codec if mp else None) or "H264").upper()
    if codec not in ("H264", "H265", "JPEG", "MPEG4"):
        codec = "H264"
    add_text(cfg, NS_TT, "Encoding", "H265" if codec == "H265" else codec)
    w, h = parse_resolution(mp.resolution if mp else None)
    res = etree.SubElement(cfg, _qn(NS_TT, "Resolution"))
    add_text(res, NS_TT, "Width", w)
    add_text(res, NS_TT, "Height", h)
    rate = etree.SubElement(cfg, _qn(NS_TT, "RateControl"))
    add_text(rate, NS_TT, "FrameRateLimit", (mp.fps if mp else None) or 25)
    add_text(rate, NS_TT, "EncodingInterval", "1")
    add_text(rate, NS_TT, "BitrateLimit", (mp.bitrate if mp else None) or 4096)


def _media_uri(resp, uri, ns):
    media_uri = etree.SubElement(resp, _qn(ns, "MediaUri"))
    add_text(media_uri, NS_TT, "Uri", uri)
    add_text(media_uri, NS_TT, "InvalidAfterConnect", "false")
    add_text(media_uri, NS_TT, "InvalidAfterReboot", "false")
    add_text(media_uri, NS_TT, "Timeout", "PT0S")


def _empty(body, ns, action):
    tag = action.split("}")[-1] if "}" in action else action
    if tag:
        etree.SubElement(body, _qn(ns, tag + "Response"))


def _scopes(config):
    tenant = str(config.tenant_id) if config.tenant_id else "platform"
    return [
        ("Fixed", "onvif://www.onvif.org/type/video_server"),
        ("Fixed", "onvif://www.onvif.org/type/network_video_transmitter"),
        ("Fixed", "onvif://www.onvif.org/Profile/Streaming"),
        ("Fixed", "onvif://www.onvif.org/Profile/G"),
        ("Configurable", f"onvif://www.onvif.org/name/{config.device_name}"),
        ("Configurable", "onvif://www.onvif.org/hardware/Neubit-VMS"),
        ("Fixed", f"onvif://www.onvif.org/tenant/{tenant}"),
    ]


def _firmware() -> str:
    try:
        return get_settings().env or "1.0"
    except Exception:  # noqa: BLE001
        return "1.0"


def _iso(dt) -> str | None:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch() -> str:
    return "1970-01-01T00:00:00Z"


def _recording_span(recs) -> tuple[str, str]:
    if not recs:
        return _epoch(), _now_iso()
    lo = min(r.start_time for r in recs)
    hi = max((r.end_time or r.start_time) for r in recs)
    return _iso(lo) or _epoch(), _iso(hi) or _now_iso()


async def _segment_at(db, camera_id, start):
    """The Recording covering ``start`` (start_time <= start <= end_time), else latest."""
    if start is not None:
        start = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
        for r in await _recordings_for(db, camera_id, limit=1000):
            st = r.start_time if r.start_time.tzinfo else r.start_time.replace(tzinfo=timezone.utc)
            en = r.end_time or st
            en = en if en.tzinfo else en.replace(tzinfo=timezone.utc)
            if st <= start <= en:
                return r
    recs = await _recordings_for(db, camera_id, limit=1)
    return recs[0] if recs else None


# ── dispatcher ────────────────────────────────────────────────────────────────
_SERVICE_DISPATCH = {
    "device_service": _device,
    "recording_service": _recording,
    "search_service": _search,
    "replay_service": _replay,
}


async def handle_soap(
    service: str,
    body_bytes: bytes,
    *,
    config: OnvifServerConfig,
    headers,
    url_hostname: str | None,
    scheme: str,
    soapaction: str | None,
    db: AsyncSession,
) -> bytes:
    """Route an authenticated SOAP request → the serialized response envelope bytes.

    ``config`` is the authenticated tenant's ONVIF config (from ``auth.authenticate``);
    every operation reads only that tenant's exposed cameras/recordings. Unknown action
    → an empty ``<Action>Response`` (never a fault) so tolerant clients keep probing.
    """
    from .xml_utils import extract_action

    action = extract_action(body_bytes, soapaction)
    ctx = _Ctx(config, headers, url_hostname, scheme, body_bytes)
    env = soap_envelope()
    body = soap_body(env)

    try:
        if service in ("media_service", "media2_service"):
            ns = NS_TR2 if service == "media2_service" else NS_TRT
            await _media(action, body, db, ctx, ns=ns)
        else:
            handler = _SERVICE_DISPATCH.get(service)
            if handler is None:
                from .auth import fault_response

                return fault_response("ter:ActionNotSupported", f"unknown service {service}")
            await handler(action, body, db, ctx)
    except Exception:  # noqa: BLE001
        log.exception("ONVIF SOAP handler error (service=%s action=%s)", service, action)
        from .auth import fault_response

        return fault_response("ter:Receiver", "internal error")

    return serialize(env)
