"""Pydantic schemas for the system-settings API."""

from __future__ import annotations

from pydantic import BaseModel


class SettingsOut(BaseModel):
    """The editable catalog + current effective values (for the admin form)."""

    catalog: list[dict]
    values: dict


class UpdateSettingsIn(BaseModel):
    """A partial map of setting key → new value (only sent keys change)."""

    values: dict


class MapsConfigOut(BaseModel):
    """Sites Map config surfaced to the browser (GET /settings/maps).

    ``enabled`` selects the provider: true (with a key) draws the map with Google
    Maps, which needs internet; false — the default — draws it with the offline
    PMTiles basemap at ``tiles_url``, which does not.

    ``api_key`` is intentionally exposed to authenticated operators because the
    Google Maps JavaScript API loader needs it in-browser; restrict it by HTTP
    referrer in Google Cloud Console.
    """

    enabled: bool = False
    api_key: str = ""
    tiles_url: str = "/tiles/planet.pmtiles"
    default_lat: float = 0.0
    default_lng: float = 0.0
    default_zoom: int = 5
