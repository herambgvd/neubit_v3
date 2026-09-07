"""The catalog of admin-editable system settings.

A single, declarative source of truth: each entry describes one setting (its key,
type, default, group, and whether it is safe to expose publicly). The API returns
this catalog so the frontend renders the settings form generically — add a setting
here and it shows up in the UI with no extra frontend work.

Settings live in the ``app_settings`` table as JSON values; anything not stored
falls back to the ``default`` below.

REMOVED, deliberately — do not re-add without a consumer:

``support_email``   had none. Not read by any service and not rendered anywhere;
                    it described a footer that does not show it.
``allow_signups``   enforced NOTHING. No signup path consulted it, so an admin
                    could turn "Open sign-ups" on and nothing happened. On a
                    physical-security product a control that implies public
                    self-registration and does not govern it is worse than absent.

A settings key is a promise that something reads it. Both promises were empty.
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
        "key": "allow_avatar_uploads",
        "type": "bool",
        "default": True,
        "group": "Features",
        "label": "Allow profile photos",
        "description": "Let users upload a profile picture.",
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
    # --- Maps ----------------------------------------------------------------
    {
        "key": "maps_tiles_url",
        "type": "text",
        "default": "/tiles/planet.pmtiles",
        "group": "Maps",
        "label": "Offline basemap archive",
        "placeholder": "/tiles/planet.pmtiles",
        "description": (
            "URL of the self-hosted PMTiles world basemap the Sites Map draws when Google Maps "
            "is off. Keep it same-origin so the map keeps working with no internet."
        ),
        "public": False,
    },
    # --- Google Maps ---------------------------------------------------------
    # Opt-in: with the toggle off (the default) the Sites Map runs on the offline
    # basemap above, which needs no key and no internet.
    #
    # The browser JS loader needs the api_key, so GET /settings/maps exposes it to
    # any authenticated user (not to the unauthenticated /public subset). The real
    # boundary is the HTTP-referrer restriction on the key in Cloud Console.
    {
        "key": "google_maps_enabled",
        "type": "bool",
        "default": False,
        "group": "Maps",
        "label": "Enable Google Maps",
        "description": (
            "Draw the Sites Map with Google Maps instead of the offline basemap. "
            "Requires internet access and an API key below."
        ),
        "public": False,
    },
    {
        "key": "google_maps_api_key",
        "type": "text",
        "default": "",
        "group": "Maps",
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
        "group": "Maps",
        "label": "Default latitude",
        "placeholder": "e.g. 22.9734",
        "description": "Initial map centre latitude when no sites have coordinates.",
        "public": False,
    },
    {
        "key": "google_maps_default_lng",
        "type": "number",
        "default": 78.6569,
        "group": "Maps",
        "label": "Default longitude",
        "placeholder": "e.g. 78.6569",
        "description": "Initial map centre longitude when no sites have coordinates.",
        "public": False,
    },
    {
        "key": "google_maps_default_zoom",
        "type": "number",
        "default": 5,
        "group": "Maps",
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


def secret_keys() -> set[str]:
    """Keys whose stored value is a credential.

    This is what enforces the catalog's `"secret": True` flag — such values are
    encrypted at rest and masked in responses.
    """
    return {row["key"] for row in CATALOG if row.get("secret")}


def known_keys() -> set[str]:
    return set(_BY_KEY)
