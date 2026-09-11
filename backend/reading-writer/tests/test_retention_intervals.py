"""The retention arithmetic, and the whitelist that guards a DDL string.

`reporting` has no suite of its own, and two things in `policies.py` deserve one:

  * `approx_seconds` decides whether raw retention is longer than the refresh
    window — the check that stops a continuous aggregate reading rows that have
    already been dropped. Getting it wrong is silent and later.
  * `_INTERVAL_RE` is a WHITELIST, not a format check. Its values land in
    ``INTERVAL '<value>'`` inside DDL, and the module reads them from environment
    variables. A second module-level name that shadowed it would replace the
    guard without anything failing — which nearly happened.

These live here because reading-writer installs `reporting` and can import it;
a test harness for one module is a bigger change than the risk deserves.
"""

from __future__ import annotations

import pytest

from reporting.policies import PolicyConfigError, _interval, approx_seconds

HOUR = 3600
DAY = 24 * HOUR


@pytest.mark.parametrize(
    "interval,seconds",
    [
        ("90 days", 90 * DAY),
        ("7 days", 7 * DAY),
        ("1 hour", HOUR),
        ("30 minutes", 30 * 60),
        ("2 years", 2 * 31556952),
        # COMPOUND. Two pairs in one string, which is the case a tightened regex
        # silently dropped half of.
        ("1 hour 30 minutes", HOUR + 30 * 60),
        ("2 days 12 hours", 2 * DAY + 12 * HOUR),
    ],
)
def test_an_interval_is_the_sum_of_its_parts(interval, seconds):
    assert approx_seconds(interval) == pytest.approx(seconds)


def test_the_space_between_a_number_and_its_unit_is_optional(monkeypatch):
    assert approx_seconds("12hours") == pytest.approx(12 * HOUR)
    assert approx_seconds("12  hours") == pytest.approx(12 * HOUR)


def test_the_plural_and_the_singular_are_the_same_interval():
    assert approx_seconds("1 day") == approx_seconds("1 days")


class TestTheWhitelist:
    """What may reach ``INTERVAL '<value>'``."""

    def test_accepts_the_forms_the_error_message_advertises(self, monkeypatch):
        for good in ("7 days", "12 hours", "2 years", "1 hour 30 minutes"):
            monkeypatch.setenv("VE_TEST_INTERVAL", good)
            assert _interval("VE_TEST_INTERVAL", "7 days") == good

    @pytest.mark.parametrize(
        "bad",
        [
            "7 days; DROP TABLE readings",
            "7 fortnights",
            "days",
            "-7 days",
            "7 days'",
        ],
    )
    def test_refuses_anything_else_rather_than_interpolating_it(self, monkeypatch, bad):
        # The value is concatenated into DDL. "Not a valid interval" is the whole
        # defence, so it has to refuse rather than pass through and let Postgres
        # decide what it meant.
        monkeypatch.setenv("VE_TEST_INTERVAL", bad)
        with pytest.raises(PolicyConfigError):
            _interval("VE_TEST_INTERVAL", "7 days")

    def test_off_is_only_honoured_where_it_is_allowed(self, monkeypatch):
        monkeypatch.setenv("VE_TEST_INTERVAL", "off")
        assert _interval("VE_TEST_INTERVAL", "7 days", allow_off=True) is None
        with pytest.raises(PolicyConfigError):
            _interval("VE_TEST_INTERVAL", "7 days")
