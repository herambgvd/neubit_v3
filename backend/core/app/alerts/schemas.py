"""Pydantic schemas for the alert inbox."""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class AlertOut(BaseModel):
    key: str
    severity: str          # info | warning | critical
    category: str          # license | quota | invoice | subscription | tenant
    title: str
    message: str
    link: str | None = None
    ts: dt.datetime | None = None
    read: bool = False


class AlertListOut(BaseModel):
    items: list[AlertOut]
    total: int
    unread: int
