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
    """Google Maps config surfaced to the browser (GET /settings/maps).

    ``api_key`` is intentionally exposed to authenticated operators because the
    Google Maps JavaScript API loader needs it in-browser; restrict it by HTTP
    referrer in Google Cloud Console.
    """

    enabled: bool = False
    api_key: str = ""
    default_lat: float = 0.0
    default_lng: float = 0.0
    default_zoom: int = 5
