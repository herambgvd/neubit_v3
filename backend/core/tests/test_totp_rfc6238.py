"""TOTP, against RFC 6238's own test vectors.

The algorithm is configurable now (sha1 / sha256 / sha512), and a configurable
crypto primitive is the kind of thing that looks right and is off by one byte. So
this checks the implementation against the values the RFC itself publishes in
Appendix B rather than against itself.

The RFC's vectors use an EIGHT-digit code and a seed per algorithm — SHA-1 takes
20 bytes, SHA-256 32, SHA-512 64 — both of which are easy to get wrong when
generalising a SHA-1-only implementation, which is exactly why they are here.
"""


import base64

import pytest

from app.auth.security import _hotp, totp_algorithm, totp_provisioning_uri

# RFC 6238 Appendix B: the seed is the ASCII string "12345678901234567890",
# repeated to the hash's block size.
SEEDS = {
    "sha1": b"12345678901234567890",
    "sha256": b"12345678901234567890123456789012",
    "sha512": b"1234567890123456789012345678901234567890123456789012345678901234",
}

def _b32(raw: bytes) -> str:
    return base64.b32encode(raw).decode().rstrip("=")

# (unix time, sha1, sha256, sha512) — the table printed in Appendix B.
VECTORS = [
    (59,          "94287082", "46119246", "90693936"),
    (1111111109,  "07081804", "68084774", "25091201"),
    (1111111111,  "14050471", "67062674", "99943326"),
    (1234567890,  "89005924", "91819424", "93441116"),
    (2000000000,  "69279037", "90698825", "38618901"),
    (20000000000, "65353130", "77737706", "47863826"),
]


@pytest.mark.parametrize("at,sha1,sha256,sha512", VECTORS)
def test_matches_the_rfc_vectors(at, sha1, sha256, sha512):
    for algorithm, expected in (("sha1", sha1), ("sha256", sha256), ("sha512", sha512)):
        counter = at // 30
        got = _hotp(_b32(SEEDS[algorithm]), counter, digits=8, algorithm=algorithm)
        assert got == expected, f"{algorithm} at t={at}: got {got}, RFC says {expected}"


class TestWhichAlgorithmIsUsed:
    def test_the_default_is_the_one_every_authenticator_assumes(self):
        # Not the strongest, deliberately. Changing it invalidates every code
        # already enrolled, and the apps that ignore the otpauth parameter do so
        # without saying anything.
        assert totp_algorithm() == "sha1"

    def test_a_configured_algorithm_is_honoured(self, monkeypatch):
        from app.core import config

        monkeypatch.setattr(config.get_settings(), "totp_algorithm", "sha256", raising=False)
        assert totp_algorithm() == "sha256"

    def test_an_unknown_value_falls_back_rather_than_raising(self, monkeypatch):
        # A typo in an environment variable must not take authentication down. It
        # would refuse every code either way; this at least refuses them with a
        # working error path.
        from app.core import config

        monkeypatch.setattr(config.get_settings(), "totp_algorithm", "sha3-512", raising=False)
        assert totp_algorithm() == "sha1"

    def test_the_provisioning_uri_tells_the_app_which_hash(self, monkeypatch):
        from app.core import config

        monkeypatch.setattr(config.get_settings(), "totp_algorithm", "sha512", raising=False)
        uri = totp_provisioning_uri("JBSWY3DPEHPK3PXP", "dave@corp.io", "Neubit")
        # Upper-case, as the otpauth spec writes it — and present at all, because an
        # app that is not told assumes SHA-1 and every code it shows is wrong.
        assert "algorithm=SHA512" in uri
