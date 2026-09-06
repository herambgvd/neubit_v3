"""A dump is SQL, not a shell script.

`psql -f` executes meta-commands, so `\\!` runs a command inside the postgres
container — the one holding pgdata and the database password. That made
POST /db/import "run anything in the database container", not "restore a backup".
Verified against the live container before this was written.

The sanitizer refuses rather than strips: quietly editing what someone believes
they are restoring is its own problem.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from main import _sanitize_dump

REAL_DUMP = b"""--
-- PostgreSQL database dump
--
SET lock_timeout = 0;
SET statement_timeout = 0;
DROP EXTENSION IF EXISTS timescaledb;
CREATE TABLE public.users (id uuid NOT NULL, email text);
COPY public.users (id, email) FROM stdin;
1\tone@example.com
2\ttwo@example.com
\\.
CREATE INDEX ix_users_email ON public.users (email);
"""


def test_a_real_dump_survives():
    """Every rejection test below is worthless if the sanitizer breaks a real
    restore."""
    out = _sanitize_dump(REAL_DUMP).decode()
    assert "CREATE TABLE public.users" in out
    assert "one@example.com" in out
    assert "\\." in out  # the COPY terminator must survive
    assert "CREATE INDEX" in out


@pytest.mark.parametrize(
    "meta",
    ["\\! echo pwned", "\\!/bin/sh", "\\i /etc/passwd", "\\o /tmp/out",
     "\\copy x from '/etc/passwd'", "\\g |cat"],
)
def test_a_shell_or_file_meta_command_is_refused(meta):
    body = f"CREATE TABLE t (id int);\n{meta}\n".encode()
    with pytest.raises(HTTPException) as caught:
        _sanitize_dump(body)
    assert caught.value.status_code == 400


def test_the_refusal_names_the_line():
    with pytest.raises(HTTPException) as caught:
        _sanitize_dump(b"SELECT 1;\nSELECT 2;\n\\! id\n")
    assert "line 3" in str(caught.value.detail)


def test_indented_and_uppercase_meta_commands_are_caught():
    """A blocklist anchored to column zero is a blocklist with a bypass."""
    for body in (b"   \\! echo x\n", b"\t\\! echo x\n"):
        with pytest.raises(HTTPException):
            _sanitize_dump(body)


def test_backslash_data_inside_a_copy_block_is_not_a_meta_command():
    """COPY data can contain anything. Treating it as SQL would refuse legitimate
    dumps — the reason the sanitizer tracks COPY state instead of scanning lines."""
    body = (
        b"COPY public.t (v) FROM stdin;\n"
        b"\\! this is data, not a command\n"
        b"\\N\n"
        b"\\.\n"
        b"SELECT 1;\n"
    )
    out = _sanitize_dump(body).decode()
    assert "this is data" in out


def test_a_meta_command_after_a_copy_block_is_still_refused():
    """The block has to CLOSE. Otherwise one COPY makes the rest of the file
    unchecked."""
    body = (
        b"COPY public.t (v) FROM stdin;\n"
        b"a\n"
        b"\\.\n"
        b"\\! echo pwned\n"
    )
    with pytest.raises(HTTPException):
        _sanitize_dump(body)


def test_pg_dumps_own_meta_commands_are_allowed():
    for meta in (b"\\restrict abc\n", b"\\unrestrict abc\n", b"\\connect db\n"):
        assert _sanitize_dump(b"SELECT 1;\n" + meta)


def test_timeouts_are_made_finite():
    """pg_dump sets them to 0, which lets a DROP hang forever behind a lock the
    live app holds."""
    out = _sanitize_dump(b"SET lock_timeout = 0;\nSET statement_timeout = 0;\n").decode()
    assert "lock_timeout = '120s'" in out
    assert "statement_timeout = '300s'" in out
    assert "= 0;" not in out


def test_timescale_extension_ddl_is_dropped():
    """The extension is installed and cannot be dropped while in use."""
    out = _sanitize_dump(b"DROP EXTENSION IF EXISTS timescaledb;\nSELECT 1;\n").decode()
    assert "timescaledb" not in out
    assert "SELECT 1;" in out
