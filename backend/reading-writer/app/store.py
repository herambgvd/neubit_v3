"""The database half: one batch in, one transaction out.

The rules this file implements, and why each one is not negotiable:

**One INSERT per batch, never one per reading.** A per-reading INSERT is what
kills these systems (contract §6). Everything here is set-based.

**``ON CONFLICT DO NOTHING`` on ``readings``.** Replay from the gateway's outbox
is expected and normal, not an error. ``PRIMARY KEY (point_id, ts)`` is what makes
a redelivery a no-op instead of a hard duplicate-key failure that would poison the
whole batch.

**The dimension row is upserted from the message.** An unknown ``point_id`` does
not cost the reading (contract §6) — the ``points`` row is written from what the
message already carries, in the SAME transaction, before the readings. There is
deliberately no foreign key, so the order is about keeping the pair consistent,
not about satisfying a constraint.

**All-or-nothing.** The points upsert and the readings insert share one
transaction. A batch that fails mid-write leaves NOTHING behind, which is exactly
what makes "do not ack until it is durably written" safe: the redelivered batch
re-does the whole thing and the primary key absorbs anything that did land.

**Models are imported, not redeclared.** ``reporting.models`` owns the schema
(contract §7); this service is its only writer.
"""

from __future__ import annotations

import datetime as dt
import logging
import uuid

from reporting.models import Point, Reading
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .envelope import ParsedReading

log = logging.getLogger("reading-writer.store")


class WriteResult:
    __slots__ = ("rows_attempted", "rows_inserted", "points_upserted")

    def __init__(self, attempted: int, inserted: int, points: int) -> None:
        self.rows_attempted = attempted
        self.rows_inserted = inserted
        self.points_upserted = points

    @property
    def duplicates(self) -> int:
        return self.rows_attempted - self.rows_inserted


class PointCache:
    """Remembers which points were touched recently, so `points` stays cold.

    Refreshing ``last_seen_at`` on every reading would make the dimension table
    as hot as the fact table for no gain. A point is re-upserted when it is new
    to this process or when its entry has aged past ``touch_sec``.

    Process-local on purpose: with several replicas each keeps its own view, and
    the worst case is that a point is upserted a few times per interval instead
    of once. The upsert is idempotent, so that costs nothing but a row lock.
    """

    def __init__(self, touch_sec: int) -> None:
        self._touch_sec = touch_sec
        self._seen: dict[uuid.UUID, float] = {}

    def due(self, point_id: uuid.UUID, now: float) -> bool:
        last = self._seen.get(point_id)
        return last is None or (now - last) >= self._touch_sec

    def mark(self, point_ids, now: float) -> None:
        for pid in point_ids:
            self._seen[pid] = now

    def forget_all(self) -> None:
        """Drop the cache after a failed write, so the next attempt re-upserts."""
        self._seen.clear()

    def __len__(self) -> int:
        return len(self._seen)


def _point_values(r: ParsedReading, now: dt.datetime) -> dict:
    return {
        "point_id": r.point_id,
        "tenant_id": r.tenant_id,
        "conn_id": r.conn_id,
        "device_id": r.device_id,
        "device_tag": r.device_tag,
        "point_tag": r.point_tag,
        "unit": r.unit,
        "category": r.category,
        "type": r.type,
        "meta": r.meta,
        "first_seen_at": now,
        "last_seen_at": now,
    }


async def write_batch(
    session: AsyncSession, rows: list[ParsedReading], cache: PointCache, now_mono: float
) -> WriteResult:
    """Upsert the dimension rows and insert the readings, in ONE transaction."""
    now = dt.datetime.now(dt.timezone.utc)

    # ── 1. dimension rows ─────────────────────────────────────────────────────
    # Deduplicate by point_id and keep the LAST occurrence: Postgres raises
    # "ON CONFLICT DO UPDATE command cannot affect row a second time" if one
    # statement presents the same key twice, so this is required, not tidiness.
    due: dict[uuid.UUID, dict] = {}
    for r in rows:
        if cache.due(r.point_id, now_mono):
            due[r.point_id] = _point_values(r, now)

    points_upserted = 0
    if due:
        stmt = insert(Point).values(list(due.values()))
        stmt = stmt.on_conflict_do_update(
            index_elements=[Point.point_id],
            set_={
                # Descriptive fields follow the gateway — a renamed device shows
                # up here and nowhere else, which is the point of the split.
                "tenant_id": stmt.excluded.tenant_id,
                "conn_id": stmt.excluded.conn_id,
                "device_id": stmt.excluded.device_id,
                "device_tag": stmt.excluded.device_tag,
                "point_tag": stmt.excluded.point_tag,
                "unit": stmt.excluded.unit,
                "category": stmt.excluded.category,
                "type": stmt.excluded.type,
                "meta": stmt.excluded.meta,
                # first_seen_at is NOT overwritten: it means what it says.
                "last_seen_at": stmt.excluded.last_seen_at,
            },
        )
        await session.execute(stmt)
        points_upserted = len(due)

    # ── 2. readings ───────────────────────────────────────────────────────────
    # Deduplicate within the batch too. ON CONFLICT DO NOTHING tolerates a
    # repeated key in one statement, but collapsing it here makes `rows_inserted`
    # honest and shrinks the statement.
    seen: dict[tuple[uuid.UUID, dt.datetime], dict] = {}
    for r in rows:
        seen[(r.point_id, r.ts)] = {
            "ts": r.ts,
            "tenant_id": r.tenant_id,
            "point_id": r.point_id,
            "num": r.num,
            "txt": r.txt,
            "quality": r.quality,
        }

    ins = insert(Reading).values(list(seen.values()))
    ins = ins.on_conflict_do_nothing(index_elements=[Reading.point_id, Reading.ts])
    result = await session.execute(ins)
    inserted = result.rowcount if result.rowcount is not None and result.rowcount >= 0 else 0

    await session.commit()
    cache.mark(due.keys(), now_mono)
    return WriteResult(len(seen), inserted, points_upserted)
