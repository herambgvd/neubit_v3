"""The catalog of admin-editable system settings.

A single, declarative source of truth: each entry describes one setting (its key,
type, default, group, and whether it is safe to expose publicly). The API returns
this catalog so the frontend renders the settings form generically — add a setting
here and it shows up in the UI with no extra frontend work.

Settings live in the ``app_settings`` table as JSON values; anything not stored
falls back to the ``default`` below.
"""

from __future__ import annotations

# type: "bool" | "text" | "number"
CATALOG: list[dict] = [
    {
        "key": "announcement",
        "type": "text",
        "default": "",
        "group": "General",
        "label": "Announcement banner",
        "placeholder": "e.g. Scheduled maintenance on Sunday, 2–4 AM",
        "description": "Shown as a banner to every signed-in user. Leave empty to hide.",
        "public": True,
    },
    {
        "key": "support_email",
        "type": "text",
        "default": "",
        "group": "General",
        "label": "Support email",
        "placeholder": "support@yourcompany.com",
        "description": "Contact address shown in the footer and system emails.",
        "public": True,
    },
    {
        "key": "allow_avatar_uploads",
        "type": "bool",
        "default": True,
        "group": "Features",
        "label": "Allow profile photos",
        "description": "Let users upload a profile picture.",
        "public": True,
    },
    {
        "key": "allow_signups",
        "type": "bool",
        "default": False,
        "group": "Features",
        "label": "Open sign-ups",
        "description": "Reserved for scenarios that expose public self-registration.",
        "public": True,
    },
    {
        "key": "audit_retention_days",
        "type": "number",
        "default": 0,
        "group": "Data retention",
        "label": "Audit log retention (days)",
        "placeholder": "e.g. 90 (0 = keep forever)",
        "description": "Automatically delete audit entries older than this. 0 keeps them forever.",
        "public": False,
    },
    # --- Google Maps ---------------------------------------------------------
    # The browser JS loader needs the api_key in-browser, so it is exposed to any
    # authenticated user via GET /settings/maps (NOT the unauthenticated /public
    # subset). The real security boundary is the HTTP-referrer restriction on the
    # key in Google Cloud Console, not hiding it from logged-in operators.
    {
        "key": "google_maps_enabled",
        "type": "bool",
        "default": False,
        "group": "Google Maps",
        "label": "Enable Google Maps",
        "description": "Render the Sites Map with Google Maps. Requires an API key below.",
        "public": False,
    },
    {
        "key": "google_maps_api_key",
        "type": "text",
        "default": "",
        "group": "Google Maps",
        "label": "Maps API key",
        "placeholder": "AIzaSy… (paste your Google Maps API key)",
        "description": "Google Maps JavaScript API key. Restrict it by HTTP referrer in Google Cloud Console.",
        "secret": True,
        "public": False,
    },
    {
        "key": "google_maps_default_lat",
        "type": "number",
        "default": 22.9734,
        "group": "Google Maps",
        "label": "Default latitude",
        "placeholder": "e.g. 22.9734",
        "description": "Initial map centre latitude when no sites have coordinates.",
        "public": False,
    },
    {
        "key": "google_maps_default_lng",
        "type": "number",
        "default": 78.6569,
        "group": "Google Maps",
        "label": "Default longitude",
        "placeholder": "e.g. 78.6569",
        "description": "Initial map centre longitude when no sites have coordinates.",
        "public": False,
    },
    {
        "key": "google_maps_default_zoom",
        "type": "number",
        "default": 5,
        "group": "Google Maps",
        "label": "Default zoom",
        "placeholder": "1–22, e.g. 5",
        "description": "Initial map zoom level (1–22).",
        "public": False,
    },
]

_BY_KEY = {item["key"]: item for item in CATALOG}


def defaults() -> dict:
    """The default value for every catalog key."""
    return {item["key"]: item["default"] for item in CATALOG}


def public_keys() -> set[str]:
    """Keys safe to serve to unauthenticated clients (banner, flags, …)."""
    return {item["key"] for item in CATALOG if item.get("public")}


def known_keys() -> set[str]:
    return set(_BY_KEY)
