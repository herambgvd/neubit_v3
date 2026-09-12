"""A floor-plan render must not stop the event loop.

`convert_floorplan` was `async` without ever awaiting: rasterising a PDF shells
out to poppler and a DXF render walks the drawing through matplotlib, and both ran
straight on the loop. One operator uploading a plan therefore froze every other
request in the `core` process for the length of the render — including the SSE
streams, so operators watching a live event feed saw it simply stop.

So the assertion here is NOT "the right bytes came back"; that passed before the
fix too. It is that a second coroutine kept being scheduled WHILE the render ran.
The renderers are replaced with fake modules that sleep in a blocking way, because
the real ones are optional deps and their speed is not the subject.
"""


import sys
import time
import types

import pytest

pytestmark = pytest.mark.asyncio

# Long enough that a blocked loop is unmistakable, short enough to stay a unit test.
RENDER_SECONDS = 0.30
TICK_SECONDS = 0.005
# A free loop gets ~60 ticks in that window. One tick can still slip through on a
# blocked loop (the coroutine is entered before the render starts), so demand many.
MIN_TICKS = 5


async def _ticks_during(coro):
    """Run `coro`, counting how many times a rival coroutine got the loop."""
    import asyncio

    ticks = 0
    task = asyncio.ensure_future(coro)
    while not task.done():
        ticks += 1
        await asyncio.sleep(TICK_SECONDS)
    return await task, ticks


class _FakeImage:
    def save(self, buf, **_kwargs) -> None:
        buf.write(b"\x89PNG-rendered")


def _install_fake_pdf2image(monkeypatch) -> None:
    def convert_from_bytes(content, **_kwargs):
        time.sleep(RENDER_SECONDS)  # stands in for poppler
        return [_FakeImage()]

    mod = types.ModuleType("pdf2image")
    mod.convert_from_bytes = convert_from_bytes
    monkeypatch.setitem(sys.modules, "pdf2image", mod)


class _FakeFigure:
    def savefig(self, buf, **_kwargs) -> None:
        buf.write(b"<svg/>")


def _install_fake_ezdxf(monkeypatch) -> None:
    ezdxf = types.ModuleType("ezdxf")
    ezdxf.read = lambda _stream: types.SimpleNamespace(modelspace=lambda: object())

    addons = types.ModuleType("ezdxf.addons")
    drawing = types.ModuleType("ezdxf.addons.drawing")
    mpl_backend = types.ModuleType("ezdxf.addons.drawing.matplotlib")

    def qfigure(_msp, **_kwargs):
        time.sleep(RENDER_SECONDS)  # stands in for the matplotlib render
        return _FakeFigure()

    mpl_backend.qfigure = qfigure
    drawing.matplotlib = mpl_backend
    addons.drawing = drawing
    ezdxf.addons = addons

    pyplot = types.ModuleType("matplotlib.pyplot")
    pyplot.close = lambda _fig: None
    matplotlib = types.ModuleType("matplotlib")
    matplotlib.pyplot = pyplot

    for name, mod in (
        ("ezdxf", ezdxf),
        ("ezdxf.addons", addons),
        ("ezdxf.addons.drawing", drawing),
        ("ezdxf.addons.drawing.matplotlib", mpl_backend),
        ("matplotlib", matplotlib),
        ("matplotlib.pyplot", pyplot),
    ):
        monkeypatch.setitem(sys.modules, name, mod)


async def _convert(content_type: str, filename: str):
    from app.sites.floor.floorplan_converter import convert_floorplan

    return await convert_floorplan(
        content=b"whatever",
        content_type=content_type,
        filename=filename,
        namespace="tenant-1",
        site_id="site-1",
    )


async def test_a_pdf_render_leaves_the_loop_free(monkeypatch):
    _install_fake_pdf2image(monkeypatch)

    result, ticks = await _ticks_during(_convert("application/pdf", "plan.pdf"))

    assert ticks >= MIN_TICKS, (
        f"only {ticks} tick(s) while a {RENDER_SECONDS}s PDF render ran — "
        "the render is back on the event loop and every SSE stream is stalled"
    )
    assert result.converted_type == "image/png"
    assert result.converted_content == b"\x89PNG-rendered"
    assert result.storage_path.startswith("tenant-1/floors/site-1/")


async def test_a_dxf_render_leaves_the_loop_free(monkeypatch):
    _install_fake_ezdxf(monkeypatch)

    result, ticks = await _ticks_during(_convert("image/vnd.dxf", "plan.dxf"))

    assert ticks >= MIN_TICKS, (
        f"only {ticks} tick(s) while a {RENDER_SECONDS}s DXF render ran — "
        "the render is back on the event loop and every SSE stream is stalled"
    )
    assert result.converted_type == "image/svg+xml"
    assert result.converted_content == b"<svg/>"


async def test_concurrent_dxf_renders_never_share_a_pyplot_figure(monkeypatch):
    """The worker thread is only safe because pyplot use is serialised.

    `qfigure` draws through pyplot's process-wide current-figure state, so two
    renders overlapping in worker threads could put one drawing's geometry in the
    other's figure. This asserts the lock actually keeps them apart.
    """
    import asyncio
    import threading

    _install_fake_ezdxf(monkeypatch)
    inside = 0
    overlapped = False
    guard = threading.Lock()

    real_qfigure = sys.modules["ezdxf.addons.drawing.matplotlib"].qfigure

    def watching_qfigure(msp, **kwargs):
        nonlocal inside, overlapped
        with guard:
            inside += 1
            if inside > 1:
                overlapped = True
        try:
            return real_qfigure(msp, **kwargs)
        finally:
            with guard:
                inside -= 1

    monkeypatch.setattr(
        sys.modules["ezdxf.addons.drawing.matplotlib"], "qfigure", watching_qfigure
    )

    await asyncio.gather(*(_convert("image/vnd.dxf", "plan.dxf") for _ in range(3)))

    assert not overlapped, "two DXF renders were inside pyplot at once"
