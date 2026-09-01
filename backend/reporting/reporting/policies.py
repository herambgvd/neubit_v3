"""Background-job policy configuration for the reporting store.

WHERE AN OPERATOR CHANGES THESE
-------------------------------
Every value below comes from an environment variable, set in ``deploy/.env``
(or the deployment's own env) and passed to the ``reporting-migrate`` service in
``deploy/docker-compose.yml``. Change the value, then:

    docker compose up -d reporting-migrate

``reporting-migrate`` runs ``alembic upgrade head`` and then ``reporting.apply``,
which RECONCILES the live policies against the environment: a policy whose
interval no longer matches is dropped and re-added. So the retention window is a
deployment setting, not a schema constant — different deployments have different
compliance rules and none of them should need a migration to satisfy.

Set a retention variable to ``off`` (or empty) to disable that retention policy
entirely — the "keep everything forever" compliance regime.

    VE_READINGS_CHUNK_INTERVAL      1 day       chunk size of the raw hypertable
                                                (applied at creation; changing it
                                                later affects only NEW chunks)

    VE_READINGS_COMPRESS_AFTER      7 days      compress raw chunks older than
    VE_READINGS_1M_COMPRESS_AFTER   30 days     compress 1-minute rollup chunks
    VE_READINGS_1H_COMPRESS_AFTER   365 days    compress 1-hour rollup chunks

    VE_READINGS_RETENTION           90 days     drop raw chunks older than
    VE_READINGS_1M_RETENTION        400 days    drop 1-minute rollups older than
    VE_READINGS_1H_RETENTION        1825 days   drop 1-hour rollups older than

    VE_READINGS_1M_REFRESH_START    2 hours     1m refresh window, oldest edge
    VE_READINGS_1M_REFRESH_END      1 minute    1m refresh window, newest edge
    VE_READINGS_1M_REFRESH_EVERY    1 minute    how often the 1m refresh runs
    VE_READINGS_1H_REFRESH_START    1 day       1h refresh window, oldest edge
    VE_READINGS_1H_REFRESH_END      1 hour      1h refresh window, newest edge
    VE_READINGS_1H_REFRESH_EVERY    5 minutes   how often the 1h refresh runs

Raw short, rollups long: raw is the audit trail and the thing that costs, the
rollups are what dashboards actually read (contract §5 — dashboards read the
rollups, never the raw table), so they outlive it by years.

SAFETY RAIL: raw retention must be comfortably longer than the 1-minute refresh
window, or ``drop_chunks`` deletes raw data before the rollup has materialised it
and the history is simply gone. ``validate()`` refuses a configuration where raw
retention is shorter than the 1m refresh start_offset, because that failure is
silent otherwise.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

# ── the objects we manage policies on ─────────────────────────────────────────
RAW = "readings"
AGG_1M = "readings_1m"
AGG_1H = "readings_1h"

_OFF = {"", "off", "none", "never", "disabled", "0"}

# A Postgres interval literal, restricted to what we are willing to interpolate
# into DDL. These land in `SELECT add_retention_policy(..., INTERVAL '<value>')`,
# so they are validated as a whitelist rather than trusted: this module reads
# environment variables, and an env var is not automatically a safe SQL literal.
_INTERVAL_RE = re.compile(
    r"^\d+\s*(microsecond|millisecond|second|minute|hour|day|week|month|year)s?"
    r"(\s+\d+\s*(microsecond|millisecond|second|minute|hour|day|week|month|year)s?)*$",
    re.IGNORECASE,
)


class PolicyConfigError(ValueError):
    """A policy environment variable is not a usable interval."""


def _interval(env: str, default: str, *, allow_off: bool = False) -> str | None:
    raw = os.getenv(env, default).strip()
    if allow_off and raw.lower() in _OFF:
        return None
    if not _INTERVAL_RE.match(raw):
        raise PolicyConfigError(
            f"{env}={raw!r} is not a valid interval. Use e.g. '7 days', '12 hours', "
            f"'2 years'" + (", or 'off' to disable." if allow_off else ".")
        )
    return raw


# Rough ordering for the safety rail below. Only needs to be good enough to catch
# "90 minutes of raw retention behind a 2 hour refresh window", not to be a
# calendar.
_SECONDS = {
    "microsecond": 1e-6, "millisecond": 1e-3, "second": 1, "minute": 60,
    "hour": 3600, "day": 86400, "week": 604800, "month": 2629746, "year": 31556952,
}


def approx_seconds(interval: str) -> float:
    total = 0.0
    for qty, unit in re.findall(r"(\d+)\s*([a-zA-Z]+)", interval):
        total += int(qty) * _SECONDS[unit.rstrip("s").lower()]
    return total


@dataclass(frozen=True)
class RefreshPolicy:
    start_offset: str
    end_offset: str
    schedule_interval: str


@dataclass(frozen=True)
class PolicyConfig:
    """The full, validated policy set for the reporting store."""

    chunk_interval: str

    compress_raw_after: str | None
    compress_1m_after: str | None
    compress_1h_after: str | None

    retain_raw: str | None
    retain_1m: str | None
    retain_1h: str | None

    refresh_1m: RefreshPolicy
    refresh_1h: RefreshPolicy

    @classmethod
    def from_env(cls) -> PolicyConfig:
        cfg = cls(
            chunk_interval=_interval("VE_READINGS_CHUNK_INTERVAL", "1 day"),
            compress_raw_after=_interval(
                "VE_READINGS_COMPRESS_AFTER", "7 days", allow_off=True
            ),
            compress_1m_after=_interval(
                "VE_READINGS_1M_COMPRESS_AFTER", "30 days", allow_off=True
            ),
            compress_1h_after=_interval(
                "VE_READINGS_1H_COMPRESS_AFTER", "365 days", allow_off=True
            ),
            retain_raw=_interval("VE_READINGS_RETENTION", "90 days", allow_off=True),
            retain_1m=_interval("VE_READINGS_1M_RETENTION", "400 days", allow_off=True),
            retain_1h=_interval("VE_READINGS_1H_RETENTION", "1825 days", allow_off=True),
            refresh_1m=RefreshPolicy(
                start_offset=_interval("VE_READINGS_1M_REFRESH_START", "2 hours"),
                end_offset=_interval("VE_READINGS_1M_REFRESH_END", "1 minute"),
                schedule_interval=_interval("VE_READINGS_1M_REFRESH_EVERY", "1 minute"),
            ),
            refresh_1h=RefreshPolicy(
                start_offset=_interval("VE_READINGS_1H_REFRESH_START", "1 day"),
                end_offset=_interval("VE_READINGS_1H_REFRESH_END", "1 hour"),
                schedule_interval=_interval("VE_READINGS_1H_REFRESH_EVERY", "5 minutes"),
            ),
        )
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.retain_raw is not None:
            window = approx_seconds(self.refresh_1m.start_offset)
            if approx_seconds(self.retain_raw) <= window:
                raise PolicyConfigError(
                    f"VE_READINGS_RETENTION={self.retain_raw!r} is not longer than "
                    f"VE_READINGS_1M_REFRESH_START={self.refresh_1m.start_offset!r}. "
                    "Raw chunks would be dropped before the 1-minute rollup has "
                    "materialised them, and that history is unrecoverable."
                )
        # Rollups outliving raw is the intended shape; warn loudly if inverted.
        if self.retain_raw and self.retain_1m and (
            approx_seconds(self.retain_1m) < approx_seconds(self.retain_raw)
        ):
            raise PolicyConfigError(
                "VE_READINGS_1M_RETENTION is shorter than VE_READINGS_RETENTION. "
                "Rollups are meant to outlive the raw rows they summarise; a "
                "shorter rollup retention throws away the cheap copy and keeps the "
                "expensive one. Set both deliberately."
            )
