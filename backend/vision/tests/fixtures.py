"""Fabricated device-response fixtures — no live hardware.

Two kinds:
  * ``FakeONVIFCamera`` — a duck-typed stand-in for ``onvif.ONVIFCamera`` whose service
    objects (devicemgmt / media / ptz / imaging / events) return simple attribute-bag
    objects mimicking python-onvif-zeep's zeep return shapes. Patched over
    ``app.vms.drivers.onvif.ONVIFCamera`` so the OnvifDriver runs its real logic against
    representative SOAP data.
  * XML / CGI string fixtures — representative Hikvision ISAPI XML + Dahua/CP-Plus CGI
    ``key=value`` bodies, patched over the ``_http`` GET helpers.

The SOAP shapes are reverse-engineered from what gvd_nvr's ``onvif_service`` code reads
(``profile.token``, ``profile.Name``, ``VideoEncoderConfiguration.Resolution.Width`` …),
so they exercise the exact parsing paths the port carried over.
"""

from __future__ import annotations

from types import SimpleNamespace as NS
from typing import Any


# ── ONVIF SOAP fixtures ──────────────────────────────────────────────────────────
def _resolution(w: int, h: int) -> NS:
    return NS(Width=w, Height=h)


def _profile(token: str, name: str, w: int, h: int, fps: int, encoding: str, ptz: bool = False) -> NS:
    """Mimic a zeep MediaProfile object as OnvifDriver reads it."""
    enc = NS(
        Resolution=_resolution(w, h),
        RateControl=NS(FrameRateLimit=fps),
        Encoding=encoding,
    )
    return NS(
        token=token,
        Name=name,
        VideoEncoderConfiguration=enc,
        VideoSourceConfiguration=NS(SourceToken=f"VideoSource_{name.split('_')[0]}"),
        PTZConfiguration=NS(token="ptzcfg") if ptz else None,
        AudioEncoderConfiguration=NS(Encoding="G711"),
        AudioOutputConfiguration=None,
    )


# Two channels × (main + sub) — the multi-channel NVR case the port must group correctly.
TWO_CHANNEL_PROFILES = [
    _profile("prof_1_main", "Channel1_Main", 1920, 1080, 25, "H264", ptz=True),
    _profile("prof_1_sub", "Channel1_Sub", 640, 480, 15, "H264"),
    _profile("prof_2_main", "Channel2_Main", 1920, 1080, 25, "H265"),
    _profile("prof_2_sub", "Channel2_Sub", 640, 480, 15, "H265"),
]

def _profile_src(token: str, name: str, w: int, h: int, fps: int, encoding: str, source: str, ptz: bool = False) -> NS:
    """Like ``_profile`` but with an explicit shared VideoSource token (single camera:
    both main + sub belong to the same physical source)."""
    p = _profile(token, name, w, h, fps, encoding, ptz)
    p.VideoSourceConfiguration = NS(SourceToken=source)
    return p


SINGLE_CAMERA_PROFILES = [
    _profile_src("mainStream", "MediaProfile000", 2560, 1440, 30, "H264", source="VideoSource_0", ptz=True),
    _profile_src("subStream", "MediaProfile001", 720, 576, 15, "H264", source="VideoSource_0"),
]


class _DeviceMgmt:
    def __init__(self, *, media2: bool = True):
        self._media2 = media2

    def GetDeviceInformation(self) -> NS:
        return NS(
            Manufacturer="ACME",
            Model="IPC-9000",
            FirmwareVersion="V5.6.3",
            SerialNumber="SN-ABC-123",
            HardwareId="HW-77",
        )

    def GetCapabilities(self, _req: Any = None) -> NS:
        return NS(
            PTZ=NS(XAddr="http://x/ptz"),
            Imaging=NS(XAddr="http://x/imaging"),
            Events=NS(XAddr="http://x/events"),
            Analytics=NS(XAddr="http://x/analytics"),
            Media=NS(XAddr="http://x/media"),
            Device=NS(XAddr="http://x/device"),
        )

    def GetNetworkInterfaces(self) -> list[NS]:
        return [NS(Info=NS(HwAddress="AA:BB:CC:DD:EE:FF"))]

    def GetServices(self, _req: Any = None) -> list[NS]:
        svcs = [
            NS(Namespace="http://www.onvif.org/ver10/device/wsdl", XAddr="http://x/device"),
            NS(Namespace="http://www.onvif.org/ver10/media/wsdl", XAddr="http://x/media"),
            NS(Namespace="http://www.onvif.org/ver10/recording/wsdl", XAddr="http://x/recording"),
        ]
        if self._media2:
            svcs.append(NS(Namespace="http://www.onvif.org/ver20/media/wsdl", XAddr="http://x/media2"))
        return svcs

    def GetRelayOutputs(self) -> list[NS]:
        return [NS(token="RelayOut1", Properties=NS(Mode="Bistable", IdleState="closed", DelayTime="PT1S"))]

    def GetDigitalInputs(self) -> list[NS]:
        return [NS(token="DigitalInput1", IdleState="closed")]

    def GetSystemDateAndTime(self) -> NS:
        return NS(TimeZone=NS(TZ="UTC"), NTP=True, DateTimeType="NTP")


class _Media:
    def __init__(self, profiles: list[NS]):
        self._profiles = profiles

    def GetProfiles(self) -> list[NS]:
        return self._profiles

    def GetVideoSources(self) -> list[NS]:
        return [NS(token="VideoSource_0")]

    def GetStreamUri(self, req: dict) -> NS:
        token = req["ProfileToken"]
        return NS(Uri=f"rtsp://cam.local:554/onvif/{token}")

    def GetSnapshotUri(self, req: dict) -> NS:
        return NS(Uri=f"http://cam.local/onvif/snapshot/{req['ProfileToken']}")


class _Media2(_Media):
    def GetProfiles(self, _req: Any = None) -> list[NS]:  # Media2 takes a Type arg
        return self._profiles


class _PTZ:
    def __init__(self):
        self.calls: list[str] = []

    def create_type(self, name: str) -> NS:
        return NS(ProfileToken=None, Velocity=None, Translation=None, Position=None, _type=name)

    def ContinuousMove(self, _req: Any) -> None:
        self.calls.append("ContinuousMove")

    def RelativeMove(self, _req: Any) -> None:
        self.calls.append("RelativeMove")

    def AbsoluteMove(self, _req: Any) -> None:
        self.calls.append("AbsoluteMove")

    def Stop(self, _req: Any) -> None:
        self.calls.append("Stop")

    def GetPresets(self, _req: Any) -> list[NS]:
        return [NS(token="1", Name="Gate"), NS(token="2", Name="Lobby")]

    def GotoPreset(self, _req: Any) -> None:
        self.calls.append("GotoPreset")

    def SetPreset(self, _req: Any) -> NS:
        return NS(PresetToken="99")

    def RemovePreset(self, _req: Any) -> None:
        self.calls.append("RemovePreset")


class _Imaging:
    def GetImagingSettings(self, _req: Any) -> NS:
        return NS(Brightness=50.0, Contrast=50.0, ColorSaturation=50.0, Sharpness=50.0, IrCutFilter="AUTO", WideDynamicRange=None)

    def SetImagingSettings(self, _req: Any) -> None:
        pass


class FakeONVIFCamera:
    """Duck-typed stand-in for ``onvif.ONVIFCamera`` (constructor signature-compatible)."""

    def __init__(self, host: str, port: int, user: str, password: str, *args, profiles: list[NS] | None = None, media2: bool = True, **kwargs):
        self.host = host
        self._profiles = profiles if profiles is not None else TWO_CHANNEL_PROFILES
        self.devicemgmt = _DeviceMgmt(media2=media2)
        self._ptz = _PTZ()

    def create_media_service(self) -> _Media:
        return _Media(self._profiles)

    def create_media2_service(self) -> _Media2:
        return _Media2(self._profiles)

    def create_ptz_service(self) -> _PTZ:
        return self._ptz

    def create_imaging_service(self) -> _Imaging:
        return _Imaging()


def make_fake_onvif(*, profiles: list[NS] | None = None, media2: bool = True):
    """Return a FakeONVIFCamera factory callable with fixed profiles/media2 support."""

    def _factory(host, port, user, password, *a, **k):
        return FakeONVIFCamera(host, port, user, password, profiles=profiles, media2=media2)

    return _factory


# ── Hikvision ISAPI XML fixtures ─────────────────────────────────────────────────
HIK_DEVICE_INFO = """<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo xmlns="http://www.hikvision.com/ver20/XMLSchema" version="2.0">
  <deviceName>NVR-Front</deviceName>
  <deviceType>NVR</deviceType>
  <model>DS-7616NI-K2</model>
  <serialNumber>DS-7616NI-K20123456789</serialNumber>
  <macAddress>44:19:b6:11:22:33</macAddress>
  <firmwareVersion>V4.30.005</firmwareVersion>
</DeviceInfo>"""

HIK_INPUT_PROXY_CHANNELS = """<?xml version="1.0" encoding="UTF-8"?>
<InputProxyChannelList xmlns="http://www.hikvision.com/ver20/XMLSchema" version="2.0">
  <InputProxyChannel>
    <id>1</id>
    <name>Front Door</name>
    <sourceInputPortDescriptor><ipAddress>192.168.1.64</ipAddress></sourceInputPortDescriptor>
  </InputProxyChannel>
  <InputProxyChannel>
    <id>2</id>
    <name>Parking</name>
    <sourceInputPortDescriptor><ipAddress>192.168.1.65</ipAddress></sourceInputPortDescriptor>
  </InputProxyChannel>
</InputProxyChannelList>"""

HIK_STREAMING_CHANNELS = """<?xml version="1.0" encoding="UTF-8"?>
<StreamingChannelList xmlns="http://www.hikvision.com/ver20/XMLSchema" version="2.0">
  <StreamingChannel>
    <id>101</id>
    <channelName>Camera 01</channelName>
    <Video><videoCodecType>H.264</videoCodecType><videoResolutionWidth>1920</videoResolutionWidth>
    <videoResolutionHeight>1080</videoResolutionHeight><maxFrameRate>2500</maxFrameRate></Video>
  </StreamingChannel>
  <StreamingChannel>
    <id>102</id>
    <channelName>Camera 01 Sub</channelName>
    <Video><videoCodecType>H.264</videoCodecType><videoResolutionWidth>640</videoResolutionWidth>
    <videoResolutionHeight>480</videoResolutionHeight><maxFrameRate>1500</maxFrameRate></Video>
  </StreamingChannel>
</StreamingChannelList>"""

HIK_PRESETS = """<?xml version="1.0" encoding="UTF-8"?>
<PTZPresetList xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <PTZPreset><id>1</id><presetName>Entrance</presetName></PTZPreset>
  <PTZPreset><id>2</id><presetName>Yard</presetName></PTZPreset>
</PTZPresetList>"""

HIK_CAPABILITIES = """<?xml version="1.0" encoding="UTF-8"?>
<DeviceCap xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <SysCap><isSupportPTZ>true</isSupportPTZ><isSupportImageEnhancement>true</isSupportImageEnhancement></SysCap>
  <EventCap><isSupportEvent>true</isSupportEvent></EventCap>
  <IOCap><isSupportInput>true</isSupportInput></IOCap>
  <ContentMgmtCap><CMSearchCap>true</CMSearchCap></ContentMgmtCap>
</DeviceCap>"""


# ── Dahua / CP-Plus CGI text fixtures ────────────────────────────────────────────
CPPLUS_SYSTEM_INFO = """deviceType=NVR5216-16P-4KS2E
processor=ARM
serialNumber=5J0ABC123456789
updateSerial=IPC-HDW"""

CPPLUS_MACHINE_NAME = "name=CP-Plus-NVR-Reception"

CPPLUS_SOFTWARE_VERSION = "version=4.001.0000000.2.R,build:2022-05-10"

CPPLUS_PRODUCT_DEFINITION = """table.ProductDefinition.MaxRemoteInputChannels=16
table.ProductDefinition.VideoInChannels=0
table.ProductDefinition.Vendor=General"""

CPPLUS_PRODUCT_DEFINITION_CAMERA = """table.ProductDefinition.MaxRemoteInputChannels=0
table.ProductDefinition.VideoInChannels=1"""

CPPLUS_VIDEO_IN_OPTIONS = """table.VideoInOptions[0].Brightness=50
table.VideoInOptions[0].Contrast=50
table.VideoInOptions[0].Saturation=50"""

CPPLUS_PTZ_PROTOCOL_CAPS = """caps.AbsolutePan=true
caps.Preset=true
caps.Tour=true"""
