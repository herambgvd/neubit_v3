"""Factory + interface-shape tests — no device access."""

from __future__ import annotations

from app.vms.drivers import (
    CameraDriver,
    CpPlusDriver,
    HikvisionDriver,
    LuminaDriver,
    OnvifDriver,
    get_driver,
    supported_brands,
)


def test_factory_returns_correct_driver_per_brand():
    assert isinstance(get_driver("onvif"), OnvifDriver)
    assert isinstance(get_driver("hikvision"), HikvisionDriver)
    assert isinstance(get_driver("hik"), HikvisionDriver)
    assert isinstance(get_driver("cpplus"), CpPlusDriver)
    assert isinstance(get_driver("cp-plus"), CpPlusDriver)
    assert isinstance(get_driver("dahua"), CpPlusDriver)
    assert isinstance(get_driver("lumina"), LuminaDriver)


def test_factory_is_case_insensitive():
    assert isinstance(get_driver("HIKVISION"), HikvisionDriver)
    assert isinstance(get_driver("  CpPlus  "), CpPlusDriver)


def test_factory_unknown_and_none_fall_back_to_onvif():
    assert isinstance(get_driver("acme-brand-x"), OnvifDriver)
    assert isinstance(get_driver(None), OnvifDriver)
    assert isinstance(get_driver(""), OnvifDriver)


def test_lumina_is_its_own_driver_not_onvif():
    # Lumina is a faithful port of neubit_v2's dedicated HTTP-API integration —
    # NOT an ONVIF subclass.
    d = get_driver("lumina")
    assert isinstance(d, LuminaDriver)
    assert not isinstance(d, OnvifDriver)


def test_supported_brands_lists_all_keys():
    brands = supported_brands()
    for b in ("onvif", "hikvision", "cpplus", "dahua", "lumina"):
        assert b in brands


def test_all_drivers_implement_the_interface():
    for brand in ("onvif", "hikvision", "cpplus", "lumina"):
        d = get_driver(brand)
        assert isinstance(d, CameraDriver)
        # Abstract surface present + callable.
        for method in (
            "discover",
            "probe",
            "enumerate_channels",
            "get_stream_uris",
            "get_capabilities",
            "get_snapshot",
            "ptz",
            "configure",
            "event_topic_map",
        ):
            assert callable(getattr(d, method))


def test_event_topic_map_shapes():
    # Every driver exposes a non-empty topic map of (event_type, severity, title) tuples.
    for brand in ("onvif", "hikvision", "cpplus"):
        m = get_driver(brand).event_topic_map()
        assert m, f"{brand} topic map empty"
        for _topic, mapping in m.items():
            assert isinstance(mapping, tuple) and len(mapping) == 3
