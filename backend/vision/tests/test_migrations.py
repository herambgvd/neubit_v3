"""The migration chain must run on an EMPTY database.

This exists because it did not, and nobody could tell. ``0025_media_node_credential``
added ``media_nodes.credential`` unguarded, while ``0001_vision_baseline`` builds its
tables from the LIVE model metadata — so once ``MediaNode`` declared the column, a
fresh database already had it by the time 0025 ran and ``alembic upgrade head`` died
with "duplicate column name: credential". Every existing deployment was fine: they had
run 0025 back when the model had no such column. Only a NEW install was broken, and
nothing in the suite ever created one.

That asymmetry is the whole point. A baseline generated from live metadata drifts
forward with the models, so any later revision that adds something the models now
declare is a latent break that only a first-time install can hit. These tests create
that install on every run.
"""

from __future__ import annotations

import pathlib

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

VISION_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _config(db_url: str) -> Config:
    cfg = Config(str(VISION_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(VISION_ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", db_url)
    return cfg


@pytest.fixture
def fresh_db(tmp_path) -> str:
    """A database file that does not exist yet — the first-install case."""
    return f"sqlite+aiosqlite:///{tmp_path / 'fresh.db'}"


def test_upgrade_head_completes_on_an_empty_database(fresh_db):
    # The one assertion that matters: a brand-new install can migrate at all.
    command.upgrade(_config(fresh_db), "head")


def test_the_chain_has_exactly_one_head(fresh_db):
    # Two heads means someone branched without merging, and `upgrade head` becomes
    # ambiguous — alembic picks one and the other revision silently never runs.
    heads = ScriptDirectory.from_config(_config(fresh_db)).get_heads()
    assert len(heads) == 1, f"expected a single head, found {heads}"


def test_every_revision_is_reachable_from_the_base(fresh_db):
    # A revision whose down_revision names a missing parent is dead weight that
    # `upgrade head` walks straight past.
    script = ScriptDirectory.from_config(_config(fresh_db))
    known = {rev.revision for rev in script.walk_revisions()}
    orphans = sorted(
        rev.revision
        for rev in script.walk_revisions()
        if rev.down_revision is not None
        and not (set(rev.down_revision) & known if isinstance(rev.down_revision, tuple) else rev.down_revision in known)
    )
    assert orphans == []


def test_downgrade_to_base_then_upgrade_again(fresh_db):
    # Every downgrade must undo its own upgrade. A revision that drops a table it
    # cannot recreate turns a rollback into a data-loss event with no way forward.
    cfg = _config(fresh_db)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
