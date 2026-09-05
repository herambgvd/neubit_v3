"""The database half: one batch in, one transaction out.

The rules this file implements, and why each one is not negotiable:

**One INSERT per batch, never one per reading.** A per-reading INSERT is what
kills these systems (contract §6). Everything here is set-based.

**``ON CONFLICT DO NOTHING`` on ``readings``.** Replay from the gateway's outbox
is expected and normal, not an error. ``PRIMARY KEY (point_id, ts)`` is what makes
a redelivery a no-op instead of a hard duplicate-key failure that would poison the
whole batch.

**A missing device classification never clears a stored one.** ``category``,
``device_type`` and ``unit`` are optional on the wire (contract §11): the gateway
omits a classification for a device it has not classified, and ``env.u`` is empty
for every source whose payload carries no unit. An absent field means "unknown",
so those three columns are upserted through ``COALESCE(excluded, stored)`` — a
message with no category leaves the stored one alone, and an operator's
correction survives the next reading. A message that DOES carry a value still
overwrites, because a reclassified device must show up here.

``unit`` joined that list later than the other two, and contract §12 recorded the
gap while it was open: it was assigned unconditionally, so a message with no
``env.u`` wrote NULL over a stored unit. It cost nothing while the gateway was
the only thing that could set a unit, and it is the same defect §11 named for
``category``.

**The dimension row follows STORED READINGS, not messages.** An unknown
``point_id`` still does not cost the reading (contract §6): the ``points`` row is
written from what the message already carries, in the SAME transaction. What
changed is WHICH points are in that statement. The readings insert runs FIRST and
returns the point ids it actually stored, and only those points are upserted.
There is deliberately no foreign key, so the order was never about satisfying a
constraint — which is what makes it free to reverse.

It had to reverse because ``last_seen_at`` and ``retired_at`` moved for ANY
message. A retained MQTT message the broker replays on every poll stores nothing
BY DESIGN — its ``(point_id, ts)`` is already there — and still dragged
``last_seen_at`` to now() and erased ``retired_at`` on the way past. Measured on
this estate: ``4F Khem Chiller02 / IWT`` carried ``last_seen_at`` three days ahead
of ``max(readings.ts)``, so a dead address counted as live, outlived the 30-day
horizon, and offered itself for confirmation exactly like a working one — which
is how ``inlet_water_temp`` came to be bound to a tag the device had stopped
publishing under, and the metric then refused ``no_data`` for a running chiller.
Retirement could not stick either: retiring such an address wrote a fact this
writer erased minutes later, invisibly.

So the two columns now mean what their names claim:

* ``last_seen_at`` — the timestamp of the newest reading this writer knows is
  STORED for the point. A reading EXISTS at that instant. Not "a message
  mentioned it".
* ``retired_at`` — cleared only inside that same statement, so only a reading
  that landed can un-retire a point.

The value is the READING's ``ts``, not ``now()``. Every reader compares this
column to a window (15 minutes fresh, 30 days to the horizon) and then queries
``readings`` BY ``ts``; an arrival clock would report "live" about a point whose
data no chart can see, which is a smaller version of the same lie. It is
ASSIGNED, not GREATEST-ed, so the inflated values already written into the live
store heal on that point's next real reading — a column that can only ever move
forward is how this one became untrue in the first place.

A duplicate teaches nothing about the point's DESCRIPTIVE fields either, and
that is deliberate rather than incidental: a rename rides on every message a
device sends, so a device that only replays one stored timestamp has no rename to
tell us about. The dimension row follows the data.

DELIBERATELY NOT DONE: no second column for "when did a message about this point
last arrive". Nothing reads one — ``LIVE_POINT``, ``_TOTALS_SQL`` and the
Portfolio's "last reading" label all already MEANT the stored reading — and a
column with no reader is a column that drifts until someone trusts it.

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
from sqlalchemy import case, func, literal
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


def _point_values(r: ParsedReading, stored_at: dt.datetime, now: dt.datetime) -> dict:
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
        # When this writer first saw the ADDRESS, which is an arrival fact and
        # stays one. `last_seen_at` is a claim about the DATA, so it carries the
        # reading's own measurement time.
        "first_seen_at": now,
        "last_seen_at": stored_at,
    }


# `meta` is absent on purpose: it is a dict, it is not a dimension anyone filters
# on, and hashing it would re-upsert every point whose gateway added a key.
_FINGERPRINT_FIELDS = (
    "tenant_id", "conn_id", "device_id", "device_tag", "point_tag",
    "unit", "category", "device_type", "type",
)


def _fingerprint(values: dict) -> int:
    """Hash of the dimension fields, so a CHANGED point re-upserts immediately."""
    return hash(tuple(values[k] for k in _FINGERPRINT_FIELDS))


def dimension_rows(
    rows: list[ParsedReading],
    stored_ids: set[uuid.UUID],
    now: dt.datetime,
) -> dict[uuid.UUID, dict]:
    """The `points` rows this batch EARNED, keyed by point_id.

    A point is in here only if one of its readings actually landed — that is the
    whole guard, and it is why a replayed retained message can no longer move
    `last_seen_at` or clear `retired_at`.

    A GENUINELY NEW POINT IS NEVER EXCLUDED BY IT. A point_id nothing has stored
    cannot collide on `(point_id, ts)`, so its first reading always lands and its
    dimension row appears in the same transaction — which is what `/bi/intake`'s
    `awaiting_first_reading` state is counting on, and the reason this guard is
    keyed on the reading rather than on the point already existing.

    `last_seen_at` is the NEWEST ts the batch carried for that point, not the ts
    of the row that happened to land. Both are true statements: a ts that
    CONFLICTED is by definition already stored, so either way a reading exists at
    the instant written. Taking the max also survives a source that publishes a
    burst out of order, which this estate does.

    Deduplicated by point_id keeping the LAST message's descriptive values —
    Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second
    time" if one statement presents the same key twice, so this is required, not
    tidiness.
    """
    latest: dict[uuid.UUID, ParsedReading] = {}
    stored_at: dict[uuid.UUID, dt.datetime] = {}
    for r in rows:
        if r.point_id not in stored_ids:
            continue
        latest[r.point_id] = r
        prev = stored_at.get(r.point_id)
        if prev is None or r.ts > prev:
            stored_at[r.point_id] = r.ts
    return {pid: _point_values(r, stored_at[pid], now) for pid, r in latest.items()}


async def write_batch(
    session: AsyncSession, rows: list[ParsedReading], cache: PointCache, now_mono: float
) -> WriteResult:
    """Insert the readings, then upsert the dimension rows they earned — ONE transaction.

    The readings go first because they are the only thing that knows whether a
    message carried data. Nothing observes the order: no foreign key, one
    transaction, all-or-nothing.
    """
    now = dt.datetime.now(dt.timezone.utc)

    # ── 1. readings ───────────────────────────────────────────────────────────
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
    # RETURNING on a DO NOTHING yields exactly the rows that LANDED, out of the
    # statement we were already running: the stored/duplicate split costs no
    # extra round-trip, no second statement and no lock, and it cannot disagree
    # with the table the way a follow-up SELECT could under concurrent writers.
    # `rowcount` is not enough — it counts the inserts without naming them, and
    # the dimension row needs to know WHICH points earned one.
    result = await session.execute(ins.returning(Reading.point_id))
    landed = result.scalars().all()
    inserted = len(landed)

    # ── 2. dimension rows ─────────────────────────────────────────────────────
    due: dict[uuid.UUID, dict] = {}
    marks: dict[uuid.UUID, int] = {}
    for pid, values in dimension_rows(rows, set(landed), now).items():
        fp = _fingerprint(values)
        if cache.due(pid, fp, now_mono):
            due[pid] = values
            marks[pid] = fp

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
                # `unit` is COALESCEd for exactly the reason `category` is, and
                # this was the "known, left alone" note at the end of contract
                # §12: it used to be assigned unconditionally, so a message with
                # no `env.u` wrote NULL over a stored unit. Harmless while the
                # gateway is the only source of units and all 313 aeon points
                # report none — and the same clobber the COALESCE rule exists to
                # prevent the moment anything else can set one. Nothing is
                # inferred here either way: an absent unit stays absent (contract
                # §11, and a fabricated `kW` on an axis is worse than a blank).
                # …and STRONGER than a COALESCE once an operator can set one.
                # COALESCE only stops a message that says NOTHING from blanking
                # a stored unit. It does not stop a message that says something
                # DIFFERENT from overwriting an operator's assertion — and an
                # operator's assertion being erased by the next reading is the
                # worst outcome the Ratings feature can have, because a wrong
                # unit renders as a real EPI. So a unit marked `unit_source =
                # 'operator'` is not touched at all; everything else keeps the
                # COALESCE it had.
                "unit": case(
                    (
                        Point.__table__.c.unit_source == literal("operator"),
                        Point.__table__.c.unit,
                    ),
                    else_=func.coalesce(stmt.excluded.unit, Point.__table__.c.unit),
                ),
                # Provenance follows the same order of precedence: an operator's
                # word stands, a wire value that actually arrived claims
                # "reading", and silence changes nothing. NOTHING here reads the
                # point TAG — `KWH_kwh` is a naming convention, and turning a
                # convention into a stored fact is the fabrication the contract
                # forbids (§17, the floor-prefix case).
                "unit_source": case(
                    (
                        Point.__table__.c.unit_source == literal("operator"),
                        Point.__table__.c.unit_source,
                    ),
                    (stmt.excluded.unit.isnot(None), literal("reading")),
                    else_=Point.__table__.c.unit_source,
                ),
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
                #
                # ASSIGNED, not GREATEST-ed. `excluded.last_seen_at` is a reading
                # ts this batch proved is stored, so assigning it lets the values
                # the old writer inflated (a `now()` with no reading behind it)
                # heal on the point's next real reading. A column that can only
                # move forward would carry those lies until someone edited the
                # table by hand.
                #
                # It does NOT heal an address that never reports again — nothing
                # can write a truthful timestamp for a point with no readings,
                # and inventing one would be the same fabrication. Those rows
                # keep the figure the old writer left and are now retirable,
                # which is the remedy `/bi/intake` could not offer before.
                "last_seen_at": stmt.excluded.last_seen_at,
                # Unconditional, and now finally allowed to be: only a point
                # that STORED a reading in this batch reaches this statement, so
                # clearing is a claim about data rather than about traffic. A
                # replayed retained message is not in `due` and can no longer
                # un-retire the address it names — which is what made retiring
                # a dead address pointless, because the writer undid it minutes
                # later and said nothing.
                #
                # A point that is genuinely REPORTING is still not retired,
                # whatever anyone said about it last month: an explicit retire
                # is a statement about the present, not a permanent ban, so a
                # real reading clears it and the point returns to BI's counts
                # with its whole history — none of which retirement ever
                # touched.
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

    await session.commit()
    # Only what was actually upserted: marking a point the batch skipped would
    # push its touch interval forward forever and `last_seen_at` would stop
    # moving.
    cache.mark(marks, now_mono)
    return WriteResult(len(seen), inserted, points_upserted)
