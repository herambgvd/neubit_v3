"""The database half: one batch in, one transaction out.

The rules this file implements, and why each one is not negotiable:

**One INSERT per batch, never one per reading.** A per-reading INSERT is what
kills these systems (contract §6). Everything here is set-based.

**``ON CONFLICT DO NOTHING`` on ``readings``.** Replay from the gateway's outbox
is expected and normal, not an error. ``PRIMARY KEY (point_id, ts)`` is what makes
a redelivery a no-op instead of a hard duplicate-key failure that would poison the
whole batch.

**A missing device classification never clears a stored one.** ``category`` and
``device_type`` are optional on the wire (contract §11): the gateway omits them
for a device it has not classified. An absent field means "unknown", so those two
columns are upserted through ``COALESCE(excluded, stored)`` — a message with no
category leaves the stored one alone, and an operator's correction survives the
next reading. A message that DOES carry a value still overwrites, because a
reclassified device must show up here.

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
from reporting.placement import reconcile_placement
from sqlalchemy import func
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

    A point is ALSO re-upserted the moment its dimension values change, not only
    when the interval expires. Without that, reclassifying a device in the
    gateway would appear to do nothing here for up to ``touch_sec`` — which
    reads exactly like the bug this whole change fixes. The fingerprint is of
    the message's dimension fields, so an unchanged point still costs nothing.
    """

    def __init__(self, touch_sec: int) -> None:
        self._touch_sec = touch_sec
        self._seen: dict[uuid.UUID, tuple[float, int]] = {}

    def due(self, point_id: uuid.UUID, fingerprint: int, now: float) -> bool:
        seen = self._seen.get(point_id)
        if seen is None:
            return True
        last, fp = seen
        return fp != fingerprint or (now - last) >= self._touch_sec

    def mark(self, marks: dict, now: float) -> None:
        for pid, fingerprint in marks.items():
            self._seen[pid] = (now, fingerprint)

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
        "device_type": r.device_type,
        "type": r.type,
        "meta": r.meta,
        "first_seen_at": now,
        "last_seen_at": now,
    }


def _fingerprint(r: ParsedReading) -> int:
    """Hash of the dimension fields, so a CHANGED point re-upserts immediately."""
    return hash(
        (
            r.tenant_id, r.conn_id, r.device_id, r.device_tag, r.point_tag,
            r.unit, r.category, r.device_type, r.type,
        )
    )


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
    marks: dict[uuid.UUID, int] = {}
    for r in rows:
        fp = _fingerprint(r)
        if cache.due(r.point_id, fp, now_mono):
            due[r.point_id] = _point_values(r, now)
            marks[r.point_id] = fp

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
                # The two OPTIONAL fields (contract §11). COALESCE, not a plain
                # assignment: a message that says nothing about the device's
                # category must not blank one an operator corrected. A message
                # that DOES carry one still wins, so a reclassification follows.
                "category": func.coalesce(
                    stmt.excluded.category, Point.__table__.c.category
                ),
                "device_type": func.coalesce(
                    stmt.excluded.device_type, Point.__table__.c.device_type
                ),
                "type": stmt.excluded.type,
                "meta": stmt.excluded.meta,
                # first_seen_at is NOT overwritten: it means what it says.
                "last_seen_at": stmt.excluded.last_seen_at,
                # A point that is REPORTING is not retired, whatever anyone
                # said about it last month. An explicit retire is a statement
                # about the present, not a permanent ban, so a reading clears
                # it and the point returns to BI's counts with its whole
                # history — none of which retirement ever touched.
                "retired_at": None,
            },
        )
        await session.execute(stmt)
        points_upserted = len(due)

        # ── 1b. inherit the device's placement ────────────────────────────────
        # The six spatial columns are NOT in the set_ above and never will be: a
        # message carries no placement, so a reading must not be able to write
        # one (contract §16, and the same no-clobber rule §11 gave `category`).
        #
        # What a reading CAN legitimately do is bring a point that has just come
        # into existence into line with the placement its DEVICE already has.
        # Nothing else can: the writer creates the `points` row (contract §6), so
        # without this a placed estate would silently un-place itself one new
        # point at a time.
        #
        # The value's only source is `device_locations`, which only the placement
        # API writes — so this is a derivation, not authorship. It is in the same
        # transaction as the readings, so it is covered by the ack rule; it skips
        # any point with an explicit point-level placement; and its
        # IS DISTINCT FROM guard means it writes nothing in the steady state.
        await reconcile_placement(session, point_ids=list(due.keys()))

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
    # Only what was actually upserted: marking a point the batch skipped would
    # push its touch interval forward forever and `last_seen_at` would stop
    # moving.
    cache.mark(marks, now_mono)
    return WriteResult(len(seen), inserted, points_upserted)
