"""The DATASET REGISTRY — what the dashboard builder can see (contract §2).

A **dataset** is a queryable relation in `neubit_reporting` plus everything the
builder needs to ask an honest question of it: a time column, dimensions,
measures, the aggregates each measure permits, the rollup relations that stand in
for it over a wide window, and the permission required to read it.

Registration is DATA. The definitions live in the `dashboard_datasets` table
(migration `0004_dashboard_datasets`), so a domain that starts publishing into the
reporting store becomes chartable with one INSERT — no release of this service.
The IoT readings dataset is the first row and is not special-cased anywhere: it
loads, validates and executes through the same code path as a dataset inserted
five minutes ago.

WHAT THIS MODULE IS RESPONSIBLE FOR
-----------------------------------
1. **Loading** the rows and parsing `definition` into typed models.
2. **Validating** them. A definition names relations and columns, and those names
   end up quoted into generated SQL, so every one of them is checked against the
   same `^[A-Za-z_][A-Za-z0-9_]*$` allowlist the generator uses. Aggregates are a
   CLOSED vocabulary of function names (`sum`, `min`, `max`, `avg`, `count`,
   `count_distinct`, `count_star`, `first`, `last`, `ratio`) — never a SQL
   fragment, because a fragment in a registry row would be a stored-SQL injection
   surface with extra steps.
3. **Refusing loudly, per row.** A dataset whose definition does not validate is
   dropped from the listing with the reason logged. Serving it half-parsed would
   let a typo become a wrong chart instead of a missing one.

A short TTL cache keeps a dashboard of twenty widgets from running twenty
registry SELECTs; it is short enough (`_TTL_SEC`) that a newly-inserted dataset
shows up without a restart, which is the point of the whole design.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Literal

from kernel.errors import NotFoundError, ValidationError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("reading_writer.registry")

# The one identifier allowlist, shared with the SQL generator. Ported from the
# standalone product's `query-builder.ts`; the design is theirs and it is sound.
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# How long a loaded registry is reused. Long enough that a 20-widget dashboard
# does not run 20 registry SELECTs; short enough that `INSERT INTO
# dashboard_datasets` is visible in the builder without restarting anything.
_TTL_SEC = 20.0

# The aggregate functions a MEASURE may map onto. Closed on purpose — a registry
# row supplies a function NAME from this set plus a column name, never SQL.
PhysFn = Literal[
    "sum", "min", "max", "avg", "count", "count_distinct", "count_star", "first", "last",
    # Composites. Neither is a SQL fragment: each names its children, which are
    # themselves closed-vocabulary aggregates.
    "ratio",
    # A DERIVED value: one aggregate minus another, over the same rows. See
    # `PhysicalAgg` for why this and `where` are the whole mechanism a derived
    # measure needs, and why it is registry data rather than a special case.
    "difference",
]

# The aggregates a BUILDER may ask for. Ported verbatim from the reference's
# `AGGREGATE_OPTIONS`, plus `first`/`last` which this store can answer and theirs
# could not. `sum` is the one that matters most: energy consumption is a sum, not
# an average, and its absence is what made v1 unable to chart consumption.
BuilderAggregate = Literal["count", "count_distinct", "sum", "avg", "min", "max", "first", "last"]


def _ident(name: str, what: str) -> str:
    if not isinstance(name, str) or not IDENT_RE.match(name):
        raise ValueError(f"{what}: {name!r} is not a valid SQL identifier")
    return name


class PhysWhere(BaseModel):
    """Restrict one aggregate to the rows where a DIMENSION equals a value.

    This is what lets a measure be a function of two different SERIES in the same
    relation rather than of one column — the missing half of a derived value. It
    becomes `FILTER (WHERE <dimension> = <bind>)`, so the value is a BOUND
    parameter and the dimension is a registry KEY resolved through
    `Definition.dimension()`; neither is a column name or a literal reaching SQL
    unchecked.

    Equality only. `in`, `like` and ranges would each widen what a registry row
    can express against the executor, and nothing needs them: a derived value
    picks named series.
    """

    model_config = ConfigDict(extra="forbid")

    dimension: str
    equals: str


class PhysicalAgg(BaseModel):
    """How one (measure, aggregate) pair is computed against one relation.

    Two composite forms, and each exists for a concrete reason:

    * `ratio` — the hourly average of a reading is `sum(num_sum)/sum(num_count)`,
      because `avg(num_avg)` would weight a bucket holding two samples the same as
      one holding sixty.

    * `difference` — a DERIVED value: one aggregate minus another. Combined with
      `where`, that is the whole mechanism. `ΔT` on a chiller is
      `avg(OWT) − avg(IWT)`: two aggregates over the same relation, each filtered
      to one series, subtracted.

      This is deliberately a registry capability rather than a hard-coded chiller
      case in the executor. The registry ROW is domain-specific (it names the tags
      `OWT` and `IWT`); the MECHANISM is not, so the next derived value — a
      pressure drop, an approach temperature, a power factor from kW and kVA — is
      another INSERT rather than another branch in `sqlgen.py`.

      **Nothing is written back.** A derived value is computed at query time from
      the rows already stored. It never becomes a row in `readings`: a stored
      derivation is a second copy of a number that can be wrong in a second way,
      and it silently ages if the formula is corrected.

      **Absence propagates.** A bucket where one side has no sample yields NULL,
      not zero, because SQL arithmetic with NULL is NULL. That is the correct
      answer — a chiller that reported its entering temperature and not its
      leaving one has no measured ΔT — and it is contract §4 arriving for free
      rather than needing a coalesce nobody should write.

      **Only LINEAR aggregates may be differenced, and the registry has to say
      so.** `avg(A) − avg(B)` is the mean difference; `min(A) − min(B)` is NOT the
      minimum difference, because min is not linear and the two minima can fall in
      different samples. This model cannot check that — it does not know what a
      measure means — so a definition that offers `min` of a difference is a
      definition that is lying, and the reviewer of the registry row is the check.
      See the `delta_t` measure's own `aggregates` list, which is `avg` and
      `last` and deliberately not `min`/`max`/`sum`.

    Everything else is `fn(column)`.
    """

    model_config = ConfigDict(extra="forbid")

    fn: PhysFn
    column: str | None = None
    numerator: "PhysicalAgg | None" = None
    denominator: "PhysicalAgg | None" = None
    left: "PhysicalAgg | None" = None
    right: "PhysicalAgg | None" = None
    # Applies to this aggregate, and — for a composite — to any child that does
    # not declare its own. That keeps a two-sided definition readable: a `ratio`
    # states its filter once instead of on both halves, and the halves can still
    # override it.
    where: PhysWhere | None = None

    @model_validator(mode="after")
    def _check(self) -> "PhysicalAgg":
        if self.fn == "ratio":
            if self.numerator is None or self.denominator is None:
                raise ValueError("ratio needs a numerator and a denominator")
        elif self.fn == "difference":
            if self.left is None or self.right is None:
                raise ValueError("difference needs a left and a right")
        elif self.fn == "count_star":
            if self.column is not None:
                raise ValueError("count_star takes no column")
        else:
            if not self.column:
                raise ValueError(f"{self.fn} needs a column")
            _ident(self.column, "measure column")
        if self.where is not None:
            _ident(self.where.dimension, "filtered-aggregate dimension")
        return self

    def walk(self) -> "list[PhysicalAgg]":
        """This node and every child, so a validator or the generator can see the
        whole tree without knowing which composite it is looking at."""
        out = [self]
        for child in (self.numerator, self.denominator, self.left, self.right):
            if child is not None:
                out.extend(child.walk())
        return out


PhysicalAgg.model_rebuild()


class Relation(BaseModel):
    """One physical store that can answer for this dataset.

    Several relations = rollup awareness (contract §2). `grain_sec` is the bucket
    width; `max_window_minutes` is the ceiling past which this relation is
    REFUSED with the name of a coarser one, never silently swapped.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    relation: str
    time_column: str
    grain_sec: int = 0
    max_window_minutes: int | None = None
    reason: str = ""

    @field_validator("relation", "time_column")
    @classmethod
    def _idents(cls, v: str) -> str:
        return _ident(v, "relation/time column")

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        if not re.match(r"^[A-Za-z0-9_]{1,32}$", v):
            raise ValueError(f"relation key {v!r} is not usable")
        return v


class AutoRule(BaseModel):
    """One step of `resolution=auto`: the first rule whose ceiling holds wins."""

    model_config = ConfigDict(extra="forbid")

    max_hours: float | None = None
    relation: str


class Join(BaseModel):
    """A dimension table joined in for labels/filters.

    Ported from the reference generator's join support, but DECLARED rather than
    picked by the client: a browser cannot name a relation to join, it can only
    reference a dimension the dataset already published.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    relation: str
    type: Literal["left", "inner"] = "left"
    # [[base_column, joined_column], ...] — equi-join only, which is all a
    # dimension lookup ever needs.
    on: list[list[str]] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> "Join":
        _ident(self.key, "join alias")
        _ident(self.relation, "join relation")
        for pair in self.on:
            if len(pair) != 2:
                raise ValueError("a join condition is a [base_column, joined_column] pair")
            _ident(pair[0], "join column")
            _ident(pair[1], "join column")
        return self


class Dimension(BaseModel):
    """A column a widget may GROUP BY, filter on, or split series by."""

    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    # "base" = the fact relation; anything else names a declared join.
    source: str = "base"
    column: str
    type: Literal["text", "uuid", "number", "bool", "time"] = "text"
    description: str = ""

    @model_validator(mode="after")
    def _check(self) -> "Dimension":
        _ident(self.key, "dimension key")
        _ident(self.column, "dimension column")
        if self.source != "base":
            _ident(self.source, "dimension source")
        return self


class Measure(BaseModel):
    """A number a widget may AGGREGATE, and the rules for doing it honestly."""

    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    type: Literal["number"] = "number"
    aggregates: list[BuilderAggregate] = Field(min_length=1)
    description: str = ""
    # Unit COLUMN, not a unit string. A dataset may say where the unit is stored;
    # it may never assert what the unit IS. Contract §4: never invent a unit.
    unit_dimension: str | None = None
    # Contract §4, generalised: "a value metric cannot be grouped across
    # incomparable series". A measure that is not comparable across series must be
    # pinned — grouped by one of `comparable_within`, or filtered to a single
    # value of one — before it may be aggregated.
    comparable: bool = True
    comparable_within: list[str] = Field(default_factory=list)
    incomparable_hint: str = ""
    # {relation_key: {aggregate: PhysicalAgg}}
    physical: dict[str, dict[str, PhysicalAgg]]

    @model_validator(mode="after")
    def _check(self) -> "Measure":
        _ident(self.key, "measure key")
        if not self.comparable and not self.comparable_within:
            raise ValueError(
                f"measure {self.key!r} is declared incomparable but names no "
                "comparable_within dimension, so nothing could ever chart it"
            )
        return self


class Defaults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    series_by: str | None = None
    label_dimension: str | None = None
    measure: str | None = None
    aggregate: BuilderAggregate | None = None


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_column: str | None = "tenant_id"
    relations: list[Relation] = Field(min_length=1)
    auto: list[AutoRule] = Field(default_factory=list)
    joins: list[Join] = Field(default_factory=list)
    dimensions: list[Dimension] = Field(default_factory=list)
    measures: list[Measure] = Field(min_length=1)
    defaults: Defaults = Field(default_factory=Defaults)

    @model_validator(mode="after")
    def _cross_check(self) -> "Definition":
        if self.tenant_column:
            _ident(self.tenant_column, "tenant column")
        rel_keys = {r.key for r in self.relations}
        if len(rel_keys) != len(self.relations):
            raise ValueError("duplicate relation key")
        for rule in self.auto:
            if rule.relation not in rel_keys:
                raise ValueError(f"auto rule names unknown relation {rule.relation!r}")
        join_keys = {j.key for j in self.joins}
        for d in self.dimensions:
            if d.source != "base" and d.source not in join_keys:
                raise ValueError(f"dimension {d.key!r} names unknown source {d.source!r}")
        dim_keys = {d.key for d in self.dimensions}
        for m in self.measures:
            for c in m.comparable_within:
                if c not in dim_keys:
                    raise ValueError(f"measure {m.key!r} names unknown dimension {c!r}")
            if m.unit_dimension and m.unit_dimension not in dim_keys:
                raise ValueError(f"measure {m.key!r} names unknown unit dimension")
            for rel in rel_keys:
                if rel not in m.physical:
                    raise ValueError(
                        f"measure {m.key!r} has no physical mapping for relation {rel!r}"
                    )
            for rel, by_agg in m.physical.items():
                if rel not in rel_keys:
                    raise ValueError(f"measure {m.key!r} maps unknown relation {rel!r}")
                # A filtered aggregate names a DIMENSION KEY, and the generator
                # resolves it through `Definition.dimension()`. Checking it here
                # means a typo is a dataset that refuses to load with a reason,
                # not a 500 the first time somebody charts it.
                for phys in by_agg.values():
                    for node in phys.walk():
                        if node.where and node.where.dimension not in dim_keys:
                            raise ValueError(
                                f"measure {m.key!r} filters on {node.where.dimension!r}, "
                                "which is not a dimension of this dataset"
                            )
                for agg in m.aggregates:
                    if agg not in by_agg:
                        raise ValueError(
                            f"measure {m.key!r} permits {agg!r} but relation {rel!r} "
                            "does not say how to compute it"
                        )
        for d in (self.defaults.series_by, self.defaults.label_dimension):
            if d and d not in dim_keys:
                raise ValueError(f"defaults name unknown dimension {d!r}")
        if self.defaults.measure and self.defaults.measure not in {m.key for m in self.measures}:
            raise ValueError("defaults name an unknown measure")
        return self

    # ── lookups the generator and the router use ─────────────────────────────

    def relation(self, key: str) -> Relation:
        for r in self.relations:
            if r.key == key:
                return r
        raise ValidationError(
            f"unknown resolution {key!r}; this dataset offers: "
            + ", ".join(r.key for r in self.relations)
        )

    def dimension(self, key: str) -> Dimension:
        for d in self.dimensions:
            if d.key == key:
                return d
        raise ValidationError(
            f"unknown column {key!r}; this dataset offers: "
            + ", ".join(d.key for d in self.dimensions)
        )

    def measure(self, key: str) -> Measure:
        for m in self.measures:
            if m.key == key:
                return m
        raise ValidationError(
            f"unknown measure {key!r}; this dataset offers: "
            + ", ".join(m.key for m in self.measures)
        )

    def join(self, key: str) -> Join:
        for j in self.joins:
            if j.key == key:
                return j
        raise ValidationError(f"unknown join {key!r}")

    def choose_relation(self, hours: float) -> Relation:
        """`resolution=auto`. Never picks a relation with a window ceiling — a
        bounded store (raw) has to be asked for by name, so a wide window can
        never quietly land on one that would refuse it."""
        for rule in self.auto:
            if rule.max_hours is None or hours <= rule.max_hours:
                rel = self.relation(rule.relation)
                if rel.max_window_minutes is None or hours * 60 <= rel.max_window_minutes:
                    return rel
        # No auto rules (or none matched): the coarsest unbounded relation.
        unbounded = [r for r in self.relations if r.max_window_minutes is None]
        if not unbounded:
            raise ValidationError("this dataset declares no relation for an unbounded window")
        return max(unbounded, key=lambda r: r.grain_sec)


class Dataset(BaseModel):
    """A registry row, parsed. `definition` is validated; the rest is metadata."""

    model_config = ConfigDict(extra="forbid")

    key: str
    name: str
    description: str = ""
    permission: str
    permission_label: str = ""
    permission_group: str = "Dashboard datasets"
    definition: Definition

    def public(self) -> dict:
        """What the builder sees. The physical mapping is deliberately NOT here —
        a browser has no use for `num_sum` and publishing it would invite a client
        to start naming physical columns."""
        d = self.definition
        return {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "permission": self.permission,
            "dimensions": [
                {"key": x.key, "label": x.label, "type": x.type, "description": x.description}
                for x in d.dimensions
            ],
            "measures": [
                {
                    "key": m.key,
                    "label": m.label,
                    "type": m.type,
                    "aggregates": list(m.aggregates),
                    "description": m.description,
                    "comparable": m.comparable,
                    "comparable_within": list(m.comparable_within),
                    "incomparable_hint": m.incomparable_hint,
                }
                for m in d.measures
            ],
            "resolutions": [
                {
                    "key": r.key,
                    "grain_sec": r.grain_sec,
                    "max_window_minutes": r.max_window_minutes,
                    "reason": r.reason,
                }
                for r in d.relations
            ],
            "defaults": d.defaults.model_dump(),
        }


# ── loading ──────────────────────────────────────────────────────────────────

_SQL = text(
    """
    SELECT key, name, description, permission, permission_label,
           permission_group, definition
      FROM dashboard_datasets
     WHERE enabled
     ORDER BY key
    """
)

_cache: tuple[float, dict[str, Dataset]] | None = None


def _parse_row(row: dict) -> Dataset | None:
    raw = row.get("definition")
    if isinstance(raw, (str, bytes)):
        raw = json.loads(raw)
    try:
        return Dataset(
            key=row["key"],
            name=row["name"],
            description=row["description"] or "",
            permission=row["permission"],
            permission_label=row["permission_label"] or "",
            permission_group=row["permission_group"] or "Dashboard datasets",
            definition=Definition.model_validate(raw),
        )
    except (PydanticValidationError, ValueError) as exc:
        # Dropped, not half-served. A dataset with a typo'd column would otherwise
        # become a wrong chart instead of a missing one.
        log.error("dataset %r is not loadable and was skipped: %s", row.get("key"), exc)
        return None


async def load(db: AsyncSession, *, fresh: bool = False) -> dict[str, Dataset]:
    """Every valid, enabled dataset, keyed by `key`. TTL-cached."""
    global _cache
    now = time.monotonic()
    if not fresh and _cache is not None and now - _cache[0] < _TTL_SEC:
        return _cache[1]
    rows = [dict(r) for r in (await db.execute(_SQL)).mappings().all()]
    out: dict[str, Dataset] = {}
    for row in rows:
        ds = _parse_row(row)
        if ds is not None:
            out[ds.key] = ds
    _cache = (now, out)
    return out


def invalidate() -> None:
    global _cache
    _cache = None


async def get(db: AsyncSession, key: str) -> Dataset:
    datasets = await load(db)
    if key not in datasets:
        # One retry against a fresh read: a dataset inserted seconds ago must not
        # look missing for the length of the cache TTL.
        datasets = await load(db, fresh=True)
    if key not in datasets:
        raise NotFoundError(f"unknown dataset {key!r}")
    return datasets[key]
