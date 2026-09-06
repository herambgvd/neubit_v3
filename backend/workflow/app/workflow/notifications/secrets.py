"""WHICH fields of a ``NotificationChannel.config`` are credentials.

The cipher is ``kernel.secrets``. Only the judgement is workflow's: config is a
provider-shaped free-form blob, so something has to say ``smtp_password`` is a
credential and ``smtp_host`` is a hostname.

The test for a key is "does holding this value alone let someone send as this
tenant", not "should a stranger see it":

  ENCRYPTED   password / smtp_password, service_account_json and the nested
              private_key (FCM), auth_key (the APNs .p8), and any api_key /
              access_token / *_secret.
  NOT         host, port, use_tls, from_address, url, timeout — routing.
              project_id, key_id, team_id, topic, client_email, private_key_id —
              identifiers that name a credential without being one, and an
              operator debugging "push went to the wrong app" needs to read them.
              service_account_file / auth_key_file — paths; the file is the secret.
  NOT         username / smtp_username — routinely the address printed on every
              message the channel sends, so encrypting it hides nothing and costs
              the operator the field naming which mailbox is sending.

Webhook headers are matched by header NAME, and loosely (substring) where the
config keys are tight: names are whatever the operator typed, and a miss leaks a
live credential while a false positive costs one unreadable header.

Not a blanket encrypt of the whole blob: that makes every channel's routing
unreadable and unsearchable to protect a hostname.
"""

from __future__ import annotations

# Exact leaf names that are credentials wherever they appear in the config tree.
_SECRET_NAMES = frozenset({
    "password", "secret", "token", "key", "apikey", "credential", "credentials",
    "service_account_json", "credentials_json",
})

# Suffixes, so a connector added later is covered without editing this file. `_id`
# is left out on purpose: `private_key_id` names a key, it is not the key.
_SECRET_SUFFIXES = ("_password", "_secret", "_token", "_key", "_credential", "_credentials")

# Header-name fragments meaning the value is a credential. Loose by design.
_SECRET_HEADER_FRAGMENTS = ("auth", "token", "secret", "key", "password", "cookie")

# Config keys whose value is a mapping of header name -> header value.
_HEADER_CONTAINERS = frozenset({"headers", "http_headers", "extra_headers"})

#: What a secret looks like in an API response. Also accepted back on update as
#: "leave this one alone" — see ``NotificationService.update_channel``.
REDACTED = "********"


def is_secret_path(path: tuple[str, ...]) -> bool:
    """Does the config leaf at ``path`` hold a credential?

    ``path`` is the chain of dict keys down to the leaf, so nesting needs no
    flattening: ``("service_account", "private_key")`` matches on its last segment,
    its sibling ``project_id`` does not.
    """
    leaf = path[-1].lower()
    if len(path) >= 2 and path[-2].lower() in _HEADER_CONTAINERS:
        return any(frag in leaf for frag in _SECRET_HEADER_FRAGMENTS)
    return leaf in _SECRET_NAMES or leaf.endswith(_SECRET_SUFFIXES)


def restore_redacted(submitted: dict | None, stored: dict | None) -> dict | None:
    """Put back the STORED value wherever an update submitted the redaction marker.

    The API renders secrets as ``REDACTED``, so an admin editing the SMTP host
    PATCHes the whole config back with ``"password": "********"`` in it. Without
    this the asterisks are stored as the password and the real one is gone.

    Only applies at secret paths; elsewhere the marker is a value the operator
    typed. The cost is that a password of eight asterisks cannot be set.
    """
    if not submitted:
        return submitted

    def _walk(sub, sto, path):
        if isinstance(sub, dict):
            out = {}
            for k, v in sub.items():
                nested = sto.get(k) if isinstance(sto, dict) else None
                out[k] = _walk(v, nested, path + (str(k),))
            return out
        if sub == REDACTED and path and is_secret_path(path) and isinstance(sto, str):
            return sto
        return sub

    return _walk(submitted, stored or {}, ())
