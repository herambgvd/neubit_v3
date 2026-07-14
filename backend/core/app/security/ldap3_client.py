"""Real LDAP/AD client backed by ``ldap3`` (optional dependency).

⚠️ LIVE-VALIDATE: this module is imported lazily by ``ldap_client.build_client``
and is NOT exercised in CI (no live directory). Validate the bind/search against a
real AD/OpenLDAP server at deployment. Install the ``directory`` extra to enable it.
"""

from __future__ import annotations

from .ldap_client import LdapEntry, LdapError

try:  # pragma: no cover - optional dep, live path only
    import ldap3
except ImportError:  # pragma: no cover
    ldap3 = None  # type: ignore


class Ldap3Client:  # pragma: no cover - live path, exercised at deployment
    def __init__(self, config, bind_password: str | None):
        if ldap3 is None:
            raise LdapError("ldap3 is not installed")
        self.cfg = config
        self.bind_password = bind_password or ""
        self._server = ldap3.Server(config.server_uri, use_ssl=config.use_ssl, get_info=ldap3.ALL)

    def _entry_from(self, attrs: dict, dn: str) -> LdapEntry:
        cfg = self.cfg

        def one(name):
            v = attrs.get(name)
            if isinstance(v, list):
                return v[0] if v else None
            return v

        groups = attrs.get(cfg.group_attr) or []
        if not isinstance(groups, list):
            groups = [groups]
        return LdapEntry(
            dn=dn,
            email=one(cfg.email_attr),
            display_name=one(cfg.name_attr),
            groups=list(groups),
        )

    def authenticate(self, username: str, password: str) -> LdapEntry:
        cfg = self.cfg
        # First bind with the service account to locate the user's DN, then rebind
        # as the user with their password (the actual authentication).
        conn = ldap3.Connection(
            self._server, user=cfg.bind_dn, password=self.bind_password, auto_bind=True
        )
        flt = cfg.user_filter.format(username=ldap3.utils.conv.escape_filter_chars(username))
        base = cfg.user_dn_base or cfg.base_dn
        conn.search(base, flt, attributes=[cfg.email_attr, cfg.name_attr, cfg.group_attr])
        if not conn.entries:
            raise LdapError("user not found in directory")
        entry = conn.entries[0]
        user_dn = entry.entry_dn
        user_conn = ldap3.Connection(self._server, user=user_dn, password=password)
        if not user_conn.bind():
            raise LdapError("invalid credentials")
        return self._entry_from(entry.entry_attributes_as_dict, user_dn)

    def search_users(self) -> list[LdapEntry]:
        cfg = self.cfg
        conn = ldap3.Connection(
            self._server, user=cfg.bind_dn, password=self.bind_password, auto_bind=True
        )
        base = cfg.user_dn_base or cfg.base_dn
        flt = cfg.user_filter.format(username="*")
        conn.search(base, flt, attributes=[cfg.email_attr, cfg.name_attr, cfg.group_attr])
        return [self._entry_from(e.entry_attributes_as_dict, e.entry_dn) for e in conn.entries]
