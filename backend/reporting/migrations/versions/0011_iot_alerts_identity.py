"""reporting: the alert wire widened — give `iot_alerts` somewhere to put it

Revision ID: 0011_iot_alerts_identity
Revises: 0010_device_locations
Create Date: 2026-08-31

WHAT WAS HALF-DONE
------------------
Pipeline contract §3 ("The alert body") specifies four optional fields beside
`conn_id` on every alert the gateway publishes:

    device_id, point_id, device_category, device_type

The gateway sends them now. Measured on the live feed:

    {"tenant_id":"default","domain":"iot","event":"alert",
     "payload":{"conn_id":"e39a8b77-…","device_id":"1c37fabb-…",
                "point_id":"728c2849-…","device_category":"hvac",
                "device_type":"chiller","alert":{…}}}

`iot_alerts` had a column for none of them. It stored the WIRE identity —
`conn_slug`, `proto`, `device_tag`, `point_addr` — and nothing keyed, so the
console could group a fault by device name and protocol and never by `energy`
vs `hvac`, which was the entire point of widening the payload. §3 says it
outright: *the gateway half is done, the store half is not.* This is the store
half.

Nothing below is code. The projector creates what a spec declares (builder
contract §9), so widening the relation is an UPDATE of one `reporting_projections`
row — four columns, one index, two dimensions, and the rollup's GROUP BY.

WHAT IS A DIMENSION AND WHAT IS ONLY A COLUMN
---------------------------------------------
`device_category` and `device_type` are DIMENSIONS: low cardinality, they are
what a device IS, and grouping by them is the question that could not be asked.

`device_id` and `point_id` are columns and NOT dimensions, deliberately. They are
uuids — one distinct value per device or per point — so registering them would
force them into the hourly rollup's GROUP BY (builder contract §9.3) and make
that rollup approach a copy of the fact table, which is the same trade `message`
already loses. What they are FOR is the join §3 names: `point_id` opens an alert
onto the series that raised it (previously impossible — §15 recorded that
`src.addr` was the only link and it is a topic path, not a key), and `device_id`
is the stable identity behind a `device_tag` that an operator can rename.

THE COALESCE RULE, AND WHY THIS PROJECTION NOW ENRICHES
-------------------------------------------------------
§3 is explicit that all four fields are optional and follow §11's rules: omitted
rather than sent as `""`, and **a consumer must never overwrite a stored value
with NULL because a message said nothing.** That is the replay contract — an
alert buffered before these fields existed replays from an Origin that has none
of them.

`ON CONFLICT DO NOTHING` satisfies the letter of that (nothing is ever
overwritten) and loses the other half: the 20 alerts already in this table were
written before the wire widened, and a redelivery carrying a category could not
reach them. So the target now declares `on_conflict: "enrich"`, which the
projector renders as

    ON CONFLICT (alert_id, ts) DO UPDATE
       SET device_category = COALESCE(excluded.device_category,
                                      iot_alerts.device_category), …
     WHERE <anything would actually change>

Missing never clobbers, carried always fills. Exactly the rule §12 settled for
`points`, applied to the projection that needed it next.

WHY THIS MIGRATION DROPS `iot_alerts_1h`
----------------------------------------
A continuous aggregate's SELECT list is fixed at creation; Timescale has no
"add a column to a cagg". `device_category` has to be one of its GROUP BY
columns — every registered `base` dimension must be, or a chart works over six
hours and 500s over six days — so the aggregate has to be rebuilt.

The projector must not do that: its DDL is additive-only, and a background
service dropping a relation underneath a live dashboard is precisely the thing
that rule forbids. (It now REFUSES the projection when it finds this drift, with
the columns named, rather than carrying on and letting a user discover it.) A
migration is the right place: it is reviewed, it is run deliberately by an
operator, and the DROP costs NOTHING — a continuous aggregate is derived, and the
projector rebuilds it from `iot_alerts` on its next reload. No alert is lost,
because no alert lives here.

`CASCADE` is needed because Timescale hangs its own policy and invalidation
objects off the view.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0011_iot_alerts_identity"
down_revision = "0010_device_locations"
branch_labels = None
depends_on = None


# The four fields §3 specifies, in the order the contract lists them. All
# OPTIONAL: an unclassified device, or an alert replayed from an outbox row
# written before these existed, sends none of them and must not be refused.
NEW_COLUMNS = [
    {"name": "device_id", "type": "uuid", "source": "payload.device_id"},
    {"name": "point_id", "type": "uuid", "source": "payload.point_id"},
    {"name": "device_category", "type": "text", "source": "payload.device_category"},
    {"name": "device_type", "type": "text", "source": "payload.device_type"},
]

NEW_DIMENSIONS = [
    {"key": "device_category", "label": "Device category", "source": "base",
     "column": "device_category", "type": "text"},
    {"key": "device_type", "label": "Device type", "source": "base",
     "column": "device_type", "type": "text"},
]

# Added to the hourly rollup's GROUP BY so the two new dimensions exist at BOTH
# resolutions. `device_id`/`point_id` are deliberately absent — see the docstring.
NEW_GROUP_BY = ["device_category", "device_type"]

NEW_INDEX = {"name": "ix_iot_alerts_category_ts", "columns": ["device_category", "ts"]}

# The dataset description said "alerts carry no device category — the wire does
# not say". The wire says now, and a description that still claims otherwise is
# the kind of stale sentence a user trusts.
NEW_DESCRIPTION = (
    "Alerts raised by the gateway's rule engine and its comms watchdog: "
    "out-of-range values, poll failures, stale points and recoveries. Charts read "
    "the 1-hour rollup; raw is available inside a 48-hour window. Each alert "
    "carries the device's category and type, so a fault is attributable to energy "
    "vs hvac vs water without a lookup — but an alert older than that wire change, "
    "or one from an unclassified device, has none and renders as absent rather "
    "than as a guess. Alerts carry no unit: this dataset counts events and never "
    "converts them."
)


def _patch(spec: dict) -> dict:
    target = spec["target"]

    have = {c["name"] for c in target["columns"]}
    for col in NEW_COLUMNS:
        if col["name"] not in have:
            target["columns"].append(dict(col))

    if not any(i["name"] == NEW_INDEX["name"] for i in target.setdefault("indexes", [])):
        target["indexes"].append(dict(NEW_INDEX))

    target["on_conflict"] = "enrich"

    for rollup in spec.get("rollups") or []:
        for col in NEW_GROUP_BY:
            if col not in rollup["group_by"]:
                rollup["group_by"].append(col)

    dataset = spec.get("dataset") or {}
    dataset["description"] = NEW_DESCRIPTION
    definition = dataset.setdefault("definition", {})
    dims = definition.setdefault("dimensions", [])
    have_dims = {d.get("key") for d in dims}
    for dim in NEW_DIMENSIONS:
        if dim["key"] not in have_dims:
            dims.append(dict(dim))

    return spec


def upgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(
        sa.text("SELECT spec FROM reporting_projections WHERE key = 'iot_alerts'")
    ).first()
    if row is None:
        # 0007 inserts it, so this cannot normally happen — but a deployment that
        # deliberately deleted the projection should not have it resurrected by a
        # migration whose job is to widen an existing one.
        return

    spec = row[0] if isinstance(row[0], dict) else json.loads(row[0])
    conn.execute(
        sa.text(
            "UPDATE reporting_projections "
            "   SET spec = CAST(:spec AS jsonb), updated_at = now() "
            " WHERE key = 'iot_alerts'"
        ).bindparams(spec=json.dumps(_patch(spec)))
    )

    # The rollup has to be rebuilt to carry the two new GROUP BY columns, and the
    # projector will not drop one. Derived data only; `iot_alerts` itself is
    # untouched and the aggregate is recreated from it on the next reload.
    conn.execute(sa.text("DROP MATERIALIZED VIEW IF EXISTS iot_alerts_1h CASCADE"))


def downgrade() -> None:
    """Take the columns back out of the SPEC. The columns themselves stay.

    Dropping `device_category` from `iot_alerts` would destroy values the gateway
    published and this migration never wrote, and the projector's own rule is that
    a column is never dropped. Reverting the registration is enough to make the
    dimensions disappear from the builder; the data waits.
    """
    conn = op.get_bind()
    row = conn.execute(
        sa.text("SELECT spec FROM reporting_projections WHERE key = 'iot_alerts'")
    ).first()
    if row is None:
        return
    spec = row[0] if isinstance(row[0], dict) else json.loads(row[0])

    names = {c["name"] for c in NEW_COLUMNS}
    spec["target"]["columns"] = [
        c for c in spec["target"]["columns"] if c["name"] not in names
    ]
    spec["target"]["indexes"] = [
        i for i in spec["target"].get("indexes") or [] if i["name"] != NEW_INDEX["name"]
    ]
    spec["target"].pop("on_conflict", None)
    for rollup in spec.get("rollups") or []:
        rollup["group_by"] = [c for c in rollup["group_by"] if c not in NEW_GROUP_BY]
    definition = (spec.get("dataset") or {}).setdefault("definition", {})
    keys = {d["key"] for d in NEW_DIMENSIONS}
    definition["dimensions"] = [
        d for d in definition.get("dimensions") or [] if d.get("key") not in keys
    ]

    conn.execute(
        sa.text(
            "UPDATE reporting_projections "
            "   SET spec = CAST(:spec AS jsonb), updated_at = now() "
            " WHERE key = 'iot_alerts'"
        ).bindparams(spec=json.dumps(spec))
    )
    # Same reasoning as upgrade(), in reverse: the aggregate must go back to the
    # narrower GROUP BY, and only a migration may drop it.
    conn.execute(sa.text("DROP MATERIALIZED VIEW IF EXISTS iot_alerts_1h CASCADE"))
