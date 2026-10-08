"""Which signals mean "exit gracefully".

The native Windows appliance's supervisor stops a child with CTRL_BREAK, which
Python delivers as SIGBREAK; there is no SIGTERM to send a console process there.
If core's shutdown hook did not listen for it, the SSE relays would hold their
connections open until the hard-kill backstop.
"""

import signal

from app.core import shutdown


def test_sigterm_and_sigint_always():
    sigs = shutdown._shutdown_signals()
    assert signal.SIGTERM in sigs
    assert signal.SIGINT in sigs


def test_sigbreak_when_the_platform_has_it(monkeypatch):
    # SIGBREAK exists only on Windows; stand one in so the branch runs everywhere.
    stand_in = signal.SIGUSR1 if hasattr(signal, "SIGUSR1") else signal.SIGBREAK
    monkeypatch.setattr(signal, "SIGBREAK", stand_in, raising=False)
    assert stand_in in shutdown._shutdown_signals()


def test_no_sigbreak_where_there_is_none(monkeypatch):
    monkeypatch.delattr(signal, "SIGBREAK", raising=False)
    assert len(shutdown._shutdown_signals()) == 2
