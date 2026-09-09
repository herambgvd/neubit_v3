"""Which console a registered dashboard belongs to.

The category exists so each console lists ITS dashboards. Two things must hold,
because both put a registration somewhere nobody can reach it:

* an unknown category is REFUSED, not stored — a typo ("cctv", "VMS ") would
  create a bucket no viewer tab names, leaving the dashboard listed by nothing;
* a registration that names no category is filed under the default and stays
  visible, rather than falling through every tab.
"""

import pytest
from pydantic import ValidationError as PydanticError

from app.dashforge.categories import DASHBOARD_CATEGORIES, DEFAULT_CATEGORY, normalize
from app.dashforge.schemas import EmbedCreate, EmbedPublic, EmbedUpdate


def _create(**over):
    body = {"name": "n", "workspace_ref": "1", "dashboard_ref": "2"}
    body.update(over)
    return EmbedCreate(**body)


def test_the_default_category_is_one_a_tab_actually_shows():
    assert DEFAULT_CATEGORY in DASHBOARD_CATEGORIES


def test_an_unnamed_category_is_filed_under_the_default_not_left_empty():
    assert _create().category == DEFAULT_CATEGORY
    assert _create(category="").category == DEFAULT_CATEGORY


def test_a_category_is_normalized_so_one_bucket_stays_one_bucket():
    # "VMS ", "vms" and " Vms" are the same console. Stored as three strings they
    # would be three buckets, two of which no tab queries.
    assert _create(category="VMS ").category == "vms"
    assert _create(category=" Building").category == "building"


def test_an_unknown_category_is_refused_rather_than_stored():
    with pytest.raises(PydanticError):
        _create(category="cctv")
    with pytest.raises(PydanticError):
        EmbedUpdate(category="analytics")


def test_the_refusal_names_the_valid_set():
    # An operator (or a script author) has to be told what IS accepted; "invalid
    # category" alone leaves them guessing at a closed set they cannot see.
    with pytest.raises(ValueError) as exc:
        normalize("cctv")
    for slug in DASHBOARD_CATEGORIES:
        assert slug in str(exc.value)


def test_an_update_that_names_no_category_leaves_it_alone():
    # `category` absent must not be read as "move it to General": an edit of the
    # name would silently relocate the dashboard out of its console.
    body = EmbedUpdate(name="renamed")
    assert "category" not in body.model_fields_set


def test_the_category_is_served_so_a_console_can_group_by_it():
    fields = EmbedPublic.model_fields
    assert "category" in fields
