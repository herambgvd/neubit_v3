"""Staging a dump: bounded, unique, and cleaned up."""

from __future__ import annotations

import main
from conftest import auth


async def test_an_oversized_dump_is_refused_by_declared_length(client, monkeypatch):
    """The agent holds the docker socket. Letting one request decide its memory
    use is not a trade worth making — and _sanitize_dump then holds several more
    copies of whatever was read."""
    monkeypatch.setattr(main, "MAX_DUMP_BYTES", 1024)
    r = await client.post("/db/import", headers=auth(), content=b"x" * 2048)
    assert r.status_code == 413


async def test_an_oversized_streamed_dump_is_refused(client, monkeypatch):
    """A client that omits Content-Length must not get an unbounded read."""
    monkeypatch.setattr(main, "MAX_DUMP_BYTES", 1024)

    async def chunks():
        for _ in range(4):
            yield b"y" * 512

    r = await client.post("/db/import", headers=auth(), content=chunks())
    assert r.status_code == 413


async def test_an_empty_body_is_400(client):
    r = await client.post("/db/import", headers=auth(), content=b"")
    assert r.status_code == 400


async def test_the_staged_file_is_removed_afterwards(client, containers):
    """It held the whole control-DB dump — password hashes, encrypted tenant
    secrets, the audit log — inside the postgres container."""
    r = await client.post("/db/import", headers=auth(), content=b"SELECT 1;\n")
    assert r.status_code == 200
    pg = next(c for c in containers if c.name == "neubit-v3-postgres-1")
    assert any(cmd[:2] == ["rm", "-f"] for cmd in pg.execs), pg.execs


async def test_the_staged_file_is_removed_even_when_the_restore_fails(client, containers):
    pg = next(c for c in containers if c.name == "neubit-v3-postgres-1")
    pg.exec_result = (1, (b"", b"ERROR: boom"))
    r = await client.post("/db/import", headers=auth(), content=b"SELECT 1;\n")
    assert r.json()["ok"] is False
    assert any(cmd[:2] == ["rm", "-f"] for cmd in pg.execs)


async def test_two_restores_do_not_share_a_path(client, containers):
    """The path was fixed, so concurrent restores interleaved into one file."""
    pg = next(c for c in containers if c.name == "neubit-v3-postgres-1")
    await client.post("/db/import", headers=auth(), content=b"SELECT 1;\n")
    await client.post("/db/import", headers=auth(), content=b"SELECT 2;\n")
    staged = [cmd[-1] for cmd in pg.execs if cmd[0] == "psql"]
    assert len(staged) == 2
    assert staged[0] != staged[1]


async def test_a_dump_with_a_shell_escape_never_reaches_psql(client, containers):
    """End to end: the refusal has to happen before the exec, not after."""
    pg = next(c for c in containers if c.name == "neubit-v3-postgres-1")
    r = await client.post("/db/import", headers=auth(), content=b"\\! echo pwned\n")
    assert r.status_code == 400
    assert not any(cmd[0] == "psql" for cmd in pg.execs)
