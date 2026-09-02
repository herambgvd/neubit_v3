"""The PROJECTION SPEC — what a domain declares in order to be projected.

One row of `neubit_reporting.reporting_projections` holds one of these, and it is
the whole recipe: which subject to consume, what relation to write, which field
of the published envelope becomes which column, what the natural key is, what
rollups to maintain, and the `dashboard_datasets` row to publish once all of that
exists.

WHY A SPEC AND NOT A PYTHON MODULE PER DOMAIN
---------------------------------------------
Exactly the argument the builder contract §2 makes about dataset registration,
applied one layer down. If projecting a new domain meant a python module, then
vision and fire would each need a release of this service before their events
could be charted — and "registration is data" would be true only of the last mile.
A domain that already publishes on the spine becomes chartable with ONE INSERT.

SAFETY
------
A spec names relations and columns and those names are quoted into DDL and DML,
so every identifier is checked against `^[A-Za-z_][A-Za-z0-9_]*$` — the same
allowlist the dashboard builder's SQL generator uses — before it goes anywhere
near a statement. Column types are a CLOSED vocabulary, never a type expression;
rollup aggregates are a CLOSED vocabulary of function names, never a SQL
fragment. Interval strings (`chunk_interval`, `retention`, refresh offsets) are
checked against `^\\d+ (second|minute|hour|day|week|month|year)s?$` rather than
passed through, because they are the one place an interval literal reaches SQL.

A spec that fails any of this is SKIPPED with the reason logged. It is never
half-applied: half a projection is a table that silently misses a column.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# The one identifier allowlist. Deliberately identical to
# `reading_writer.api.registry.IDENT_RE` — the two halves of this pipeline must
# not disagree about what a legal column name is.
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# The one interval form. Postgres would accept far more, but everything wider is
# an opportunity to smuggle something into an unparameterisable position.
INTERVAL_RE = re.compile(r"^\d+ (second|minute|hour|day|week|month|year)s?$")

# Closed column-type vocabulary. Each maps to exactly one Postgres type and one
# python coercion (`extract.py`); nothing here is a free-text type expression.
ColumnType = Literal["timestamptz", "uuid", "text", "bigint", "double precision", "boolean", "jsonb"]

PG_TYPE = {
    "timestamptz": "timestamptz",
    "uuid": "uuid",
    "text": "text",
    "bigint": "bigint",
    "double precision": "double precision",
    "boolean": "boolean",
    "jsonb": "jsonb",
}

# Closed rollup-aggregate vocabulary. `count_star` is the one that takes no
# column; everything else is fn(column).
RollupFn = Literal["count_star", "count", "sum", "min", "max", "avg"]


def _ident(name: str, what: str) -> str:
    if not isinstance(name, str) or not IDENT_RE.match(name):
        raise ValueError(f"{what}: {name!r} is not a valid SQL identifier")
    return name


def _interval(value: str, what: str) -> str:
    if not isinstance(value, str) or not INTERVAL_RE.match(value.strip()):
        raise ValueError(
            f"{what}: {value!r} is not an accepted interval "
            "(use e.g. '1 hour', '7 days', '1825 days')"
        )
    return value.strip()


class Source(BaseModel):
    """Where the events come from: a JetStream stream and a subject filter.

    The stream must already capture the subject. For a platform domain that means
    the subject is in `kernel.events.EVENTS_SUBJECTS` — a domain missing from that
    list publishes onto a subject NO stream captures, the realtime relays still
    see it, and a durable consumer cannot be created on it at all. That failure is
    reported by name at startup rather than being swallowed.
    """

    model_config = ConfigDict(extra="forbid")

    stream: str = "EVENTS"
    subject: str
    durable: str

    @field_validator("subject")
    @classmethod
    def _subject(cls, v: str) -> str:
        # NATS subject tokens: alphanumerics, `_`, `-`, plus the `*` and `>`
        # wildcards. Anything else is a typo that would silently match nothing.
        if not re.match(r"^[A-Za-z0-9_.*>-]+$", v or ""):
            raise ValueError(f"subject {v!r} is not a usable NATS subject filter")
        return v

    @field_validator("stream", "durable")
    @classmethod
    def _names(cls, v: str) -> str:
        if not re.match(r"^[A-Za-z0-9_-]{1,64}$", v or ""):
            raise ValueError(f"{v!r} is not a usable stream/durable name")
        return v


class Column(BaseModel):
    """One projected column: a name, a type, and where in the envelope it lives.

    `source` is a DOTTED PATH into the decoded envelope
    (`{event_id, tenant_id, type, occurred_at, source, payload}`), so
    `payload.occurred_at` is the domain's own event time and `tenant_id` is the
    envelope's. It is resolved by dictionary lookup in python — it is never
    interpolated anywhere.

    `tenant: true` marks the column that carries the tenant. Its raw value goes
    through the tenant resolver (`app/tenants.py`) instead of a plain uuid cast,
    because a system-scoped event's tenant segment is the literal `platform`.

    `required: true` means a message without it can NEVER become a row. Such a
    message is acked and counted under `projector_messages_malformed_total` with
    a reason — the one place this service discards data, and it is never silent.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    type: ColumnType = "text"
    source: str
    required: bool = False
    tenant: bool = False
    # A literal fallback when the path is absent. Deliberately NOT a way to
    # manufacture a measurement: use it for a categorical default like
    # `"unknown"`, never for a number nobody produced. Absence must render as
    # absence (builder contract §4), so leaving this unset is the default.
    default: Any = None

    @model_validator(mode="after")
    def _check(self) -> "Column":
        _ident(self.name, "column name")
        if not self.source or not all(
            re.match(r"^[A-Za-z0-9_-]+$", part) for part in self.source.split(".")
        ):
            raise ValueError(f"column {self.name!r}: source path {self.source!r} is not usable")
        if self.tenant and self.type != "uuid":
            raise ValueError(f"column {self.name!r} is the tenant column so it must be a uuid")
        return self


class Index(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    columns: list[str] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def _check(self) -> "Index":
        _ident(self.name, "index name")
        for c in self.columns:
            _ident(c, "index column")
        return self


class Target(BaseModel):
    """The relation the events land in.

    It is a TimescaleDB hypertable partitioned on `time_column`, which is why the
    natural key has to include that column: a hypertable's unique index must
    contain its partitioning column. That constraint and the idempotency
    requirement point the same way, so nothing is given up for it — the natural
    key is `(source event id, event time)` and `ON CONFLICT DO NOTHING` makes a
    redelivery a no-op instead of a duplicate-key failure that would poison the
    whole batch.
    """

    model_config = ConfigDict(extra="forbid")

    relation: str
    time_column: str
    natural_key: list[str] = Field(min_length=1, max_length=4)
    columns: list[Column] = Field(min_length=2)
    indexes: list[Index] = Field(default_factory=list)
    chunk_interval: str = "7 days"
    # Applied as a TimescaleDB retention policy. Omit for "keep forever".
    retention: str | None = None
    # What a redelivery of an already-stored natural key does.
    #
    #   "nothing" — `ON CONFLICT DO NOTHING`. The default and the right answer for
    #       a wire whose fields never change: the first write wins, a replay is a
    #       no-op, and nothing stored can be disturbed.
    #
    #   "enrich"  — `ON CONFLICT DO UPDATE SET c = COALESCE(excluded.c, stored.c)`
    #       for every non-key column. This is the pipeline contract §12 rule
    #       ("missing never clobbers") applied to a projection: a message that
    #       omits a field leaves the stored value alone, and a message that
    #       CARRIES one fills a column that was NULL because the publisher had
    #       nothing to say when the row was first written. It is what makes a
    #       widened wire reach rows that predate the widening, without ever
    #       letting an old replay erase what a newer message taught us.
    #
    # It is opt-in per projection because the two behaviours are not
    # interchangeable: `enrich` means a later message can change a stored row, and
    # a domain that wants "first write wins, immutably" must be able to say so.
    on_conflict: Literal["nothing", "enrich"] = "nothing"

    @model_validator(mode="after")
    def _check(self) -> "Target":
        _ident(self.relation, "target relation")
        _ident(self.time_column, "time column")
        _interval(self.chunk_interval, f"{self.relation}.chunk_interval")
        if self.retention:
            _interval(self.retention, f"{self.relation}.retention")
        names = [c.name for c in self.columns]
        if len(set(names)) != len(names):
            raise ValueError("duplicate column name in the target")
        if self.time_column not in names:
            raise ValueError(f"time column {self.time_column!r} is not one of the columns")
        for k in self.natural_key:
            if k not in names:
                raise ValueError(f"natural key names {k!r}, which is not a column")
        if self.time_column not in self.natural_key:
            # Not a preference: `create_hypertable` refuses a unique index that
            # does not contain the partitioning column, so this would fail at DDL
            # time with a message nobody would connect back to the spec.
            raise ValueError(
                f"the natural key must include the time column {self.time_column!r} — "
                "a hypertable's unique index has to contain its partitioning column"
            )
        tenants = [c for c in self.columns if c.tenant]
        if len(tenants) > 1:
            raise ValueError("only one column may be the tenant column")
        for idx in self.indexes:
            for c in idx.columns:
                if c not in names:
                    raise ValueError(f"index {idx.name!r} names unknown column {c!r}")
        return self

    def column(self, name: str) -> Column:
        for c in self.columns:
            if c.name == name:
                return c
        raise KeyError(name)


class RollupAgg(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    fn: RollupFn
    column: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "RollupAgg":
        _ident(self.name, "rollup aggregate name")
        if self.fn == "count_star":
            if self.column:
                raise ValueError("count_star takes no column")
        elif not self.column:
            raise ValueError(f"{self.fn} needs a column")
        else:
            _ident(self.column, "rollup aggregate column")
        return self

    def sql(self) -> str:
        if self.fn == "count_star":
            return f'count(*) AS "{self.name}"'
        return f'{self.fn}("{self.column}") AS "{self.name}"'


class Refresh(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_offset: str = "7 days"
    end_offset: str = "1 hour"
    schedule_interval: str = "5 minutes"

    @model_validator(mode="after")
    def _check(self) -> "Refresh":
        for f in ("start_offset", "end_offset", "schedule_interval"):
            _interval(getattr(self, f), f"refresh.{f}")
        return self


class Rollup(BaseModel):
    """A continuous aggregate over the target, and the registry's cheap answer.

    Every dimension the dataset registers has to be a GROUP BY column here. The
    registry has ONE dimension list for all of a dataset's relations, so a
    dimension the rollup does not carry would generate SQL naming a column that
    does not exist in it — a chart that works over six hours and 500s over six
    days. `_check` on `Projection` enforces that rather than leaving it to be
    discovered by a user.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    relation: str
    bucket: str
    time_column: str = "bucket"
    group_by: list[str] = Field(min_length=1, max_length=16)
    aggregates: list[RollupAgg] = Field(min_length=1, max_length=16)
    # `false` materialises only, so the newest bucket is missing until the next
    # refresh. `true` UNIONs the materialised part with a live read, so the
    # current bucket is present — which is what a dashboard that says "today"
    # needs in order not to draw a hole and call it zero.
    real_time: bool = True
    refresh: Refresh = Field(default_factory=Refresh)
    retention: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "Rollup":
        if not re.match(r"^[A-Za-z0-9_]{1,32}$", self.key):
            raise ValueError(f"rollup key {self.key!r} is not usable")
        _ident(self.relation, "rollup relation")
        _ident(self.time_column, "rollup time column")
        _interval(self.bucket, f"{self.relation}.bucket")
        if self.retention:
            _interval(self.retention, f"{self.relation}.retention")
        for c in self.group_by:
            _ident(c, "rollup group column")
        names = [a.name for a in self.aggregates] + list(self.group_by) + [self.time_column]
        if len(set(names)) != len(names):
            raise ValueError("a rollup output name is used twice")
        return self


class Projection(BaseModel):
    """One whole recipe. The unit a domain inserts to become chartable."""

    model_config = ConfigDict(extra="forbid")

    source: Source
    target: Target
    rollups: list[Rollup] = Field(default_factory=list, max_length=4)
    # The `dashboard_datasets` row published once the relations exist. Left out
    # for a projection that is collected but deliberately not chartable yet.
    dataset: dict | None = None

    @model_validator(mode="after")
    def _check(self) -> "Projection":
        cols = {c.name for c in self.target.columns}
        keys = set()
        for r in self.rollups:
            if r.key in keys:
                raise ValueError(f"duplicate rollup key {r.key!r}")
            keys.add(r.key)
            if r.relation == self.target.relation:
                raise ValueError("a rollup cannot have the same name as the target relation")
            for c in r.group_by:
                if c not in cols:
                    raise ValueError(f"rollup {r.key!r} groups by {c!r}, which is not a column")
            for a in r.aggregates:
                if a.column and a.column not in cols:
                    raise ValueError(f"rollup {r.key!r} aggregates {a.column!r}, not a column")
        # The dimension/rollup agreement described in `Rollup`'s docstring. Caught
        # here because only here are both halves visible.
        if self.dataset:
            definition = self.dataset.get("definition") or {}
            dims = [
                d.get("column")
                for d in (definition.get("dimensions") or [])
                if (d.get("source") or "base") == "base"
            ]
            for r in self.rollups:
                missing = [d for d in dims if d and d not in r.group_by]
                if missing:
                    raise ValueError(
                        f"rollup {r.key!r} does not carry dimension column(s) "
                        f"{', '.join(sorted(missing))}; a chart on that resolution "
                        "would name a column the rollup does not have"
                    )
        return self

    @property
    def tenant_column(self) -> Column | None:
        for c in self.target.columns:
            if c.tenant:
                return c
        return None


class ProjectionRow(BaseModel):
    """A registry row, parsed."""

    model_config = ConfigDict(extra="forbid")

    key: str
    name: str
    description: str = ""
    spec: Projection

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        if not re.match(r"^[A-Za-z0-9_]{1,64}$", v or ""):
            raise ValueError(f"projection key {v!r} is not usable")
        return v
