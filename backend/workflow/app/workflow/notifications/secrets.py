"""WHICH fields of a ``NotificationChannel.config`` are credentials.

The cipher itself is ``kernel.secrets`` (one derivation for the platform, per-tenant
key, ``enc:v1:`` marker at rest, legacy plaintext readable). What is here is the
only part of the problem that is workflow's: config is a provider-shaped free-form
blob, so SOMETHING has to say that ``smtp_password`` is a credential and
``smtp_host`` is a hostname. That judgement is domain knowledge, it changes when a
connector is added, and it has no business in a package nine services import.

HOW THE LIST WAS DECIDED. By reading what the connectors actually pull out of the
config -- ``connectors/email.py``, ``connectors/webhook.py``, ``connectors/push.py``
-- and asking of each key: does holding this value alone let someone send as this
tenant? Not "is it configuration a stranger should not see", which is how a config
blob ends up entirely opaque and undebuggable.

  ENCRYPTED   password / smtp_password (SMTP auth), service_account_json and the
              nested private_key inside service_account (FCM: mints the OAuth2
              bearer), auth_key (the APNs .p8 -- signs the ES256 JWT), and any
              api_key / access_token / *_secret a whatsapp or sms channel carries.
  NOT         host, port, use_tls, from_address, url, timeout -- routing, not
              access. project_id, key_id, team_id, topic/bundle_id, client_email,
              private_key_id -- IDENTIFIERS. They name a credential; they are not
              one, they appear in provider dashboards and in support tickets, and
              an operator diagnosing "push is going to the wrong app" needs to read
              them. service_account_file / auth_key_file -- filesystem PATHS; the
              secret is the file, protected by the filesystem.
  NOT         username / smtp_username. It is half of a credential pair and the
              half that is routinely an email address printed on the sender of
              every message the channel has ever delivered. Encrypting it hides
              nothing from anyone who has the outbox and costs the operator the one
              field that identifies which mailbox a channel is sending as.

WEBHOOK HEADERS are the interesting case: the URL is not a secret and the bearer
token in ``headers.Authorization`` is. So headers are matched by HEADER NAME, and
that match is deliberately loose (substring) where the config keys above are tight.
Header names are whatever the operator typed -- ``X-Api-Key``, ``X-Vendor-Token``,
``Api-Secret`` -- so a miss leaks a live credential while a false positive costs
only the readability of one header. The asymmetry of those two outcomes is the
whole argument.

DELIBERATELY NOT a blanket encrypt of the whole ``config`` blob: it would make
every channel's routing unreadable in the database and unsearchable in a query, to
protect a hostname nobody was attacking.
"""

from __future__ import annotations

# Exact leaf names that are credentials wherever they appear in the config tree.
_SECRET_NAMES = frozenset({
    "password", "secret", "token", "key", "apikey", "credential", "credentials",
    "service_account_json", "credentials_json",
})

# Suffixes, so a connector added later gets the same treatment without editing this
# file. `_id` is NOT in here on purpose -- `private_key_id` and `key_id` name a key,
# they are not the key.
_SECRET_SUFFIXES = ("_password", "_secret", "_token", "_key", "_credential", "_credentials")

# Header-name fragments that mean the value is a credential. Loose by design; see
# the module docstring for why the asymmetry runs this way for headers only.
_SECRET_HEADER_FRAGMENTS = ("auth", "token", "secret", "key", "password", "cookie")

# Config keys whose value is a mapping of header name -> header value.
_HEADER_CONTAINERS = frozenset({"headers", "http_headers", "extra_headers"})

#: What a secret looks like in an API response. Also accepted BACK on update as
#: "leave this one alone" -- see ``NotificationService.update_channel``.
REDACTED = "********"


def is_secret_path(path: tuple[str, ...]) -> bool:
    """Does the config leaf at ``path`` hold a credential?

    ``path`` is the chain of dict keys from the root of ``config`` to the string
    leaf, so nesting is handled without the caller flattening anything: FCM's
    ``("service_account", "private_key")`` matches on its last segment and its
    sibling ``("service_account", "project_id")`` does not.
    """
    leaf = path[-1].lower()
    if len(path) >= 2 and path[-2].lower() in _HEADER_CONTAINERS:
        return any(frag in leaf for frag in _SECRET_HEADER_FRAGMENTS)
    return leaf in _SECRET_NAMES or leaf.endswith(_SECRET_SUFFIXES)


def restore_redacted(submitted: dict | None, stored: dict | None) -> dict | None:
    """Put back the STORED value wherever an update submitted the redaction marker.

    THE FAILURE THIS PREVENTS: the API shows a channel's config with secrets
    replaced by ``REDACTED``. An admin edits the SMTP host in the UI and PATCHes the
    whole config back -- including ``"password": "********"``, because that is what
    was rendered into the form. Without this, the literal asterisks get encrypted
    and stored, the real password is gone, and nothing tells anyone until the next
    alert fails to send. A value that is exactly the marker is therefore read as
    "unchanged", never as a new secret; an operator who genuinely wants a password
    of eight asterisks has to pick a different one, which is a trade worth making.

    Only applies at secret paths -- a non-secret field is echoed back in full, so
    the marker appearing there is a real value the operator typed.
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
