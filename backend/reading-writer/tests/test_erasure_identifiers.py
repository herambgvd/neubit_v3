"""That the one module which interpolates identifiers into SQL refuses bad ones.

`reporting/erasure.py` builds `DELETE FROM "<relation>"` by hand, because a table
name cannot be a bind parameter. The names come from the Postgres catalog and
from projection specs that `app/projections/spec.py` has already validated — so
the check here is redundant, and that is exactly why it is worth a test. "The
other end validates it" is how a validation quietly stops being in force; the
guard only counts while something fails when it is removed.
"""

from __future__ import annotations

import pytest

from reporting.erasure import _ident


@pytest.mark.parametrize(
    "name",
    ["readings", "access_events", "_materialized_hypertable_8", "T", "a1_b2"],
)
def test_accepts_a_real_relation_name(name):
    assert _ident(name, "relation") == name


@pytest.mark.parametrize(
    "name",
    [
        'readings" WHERE true; DROP TABLE points; --',
        "readings; DELETE FROM points",
        "public.readings",
        "readings-1h",
        "1readings",
        "",
        None,
    ],
)
def test_refuses_anything_else(name):
    with pytest.raises(ValueError):
        _ident(name, "relation")
