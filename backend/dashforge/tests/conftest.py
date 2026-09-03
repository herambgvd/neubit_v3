"""pytest-asyncio in the mode this suite is written for (bare @pytest.mark.asyncio)."""

import pytest


def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: run the coroutine test")
