"""Strip the retired dashboards.* keys out of every role that holds one

Revision ID: 0021_drop_dashboards_permissions
Revises: 0020_widen_alembic_version
Create Date: 2026-09-03

NeuBit's own dashboard builder was retired on 2026-09-03 (DashForge is the
dashboarding surface now), and with it went ``dashboards.read`` /
``dashboards.manage`` from ``app.auth.permissions``. Deleting the keys from the
catalog is not enough on its own, and the failure it leaves behind is not the
obvious one.

WHAT WOULD BREAK WITHOUT THIS
-----------------------------
``roles.permissions`` is a JSON array of key STRINGS. Nothing rewrites those rows
when the catalog changes, so a role granted ``dashboards.read`` keeps the string
forever. Two consequences:

* Harmless one: the key is carried in the JWT permissions claim and no code
  anywhere checks it. Dead weight, not a privilege — the service that enforced it
  no longer exists, and no route can be reached with it.
* The one that bites: ``AuthService`` re-validates the WHOLE permission list on
  every role update (``dynamic_permissions.unknown()`` →
  ``ValidationError("unknown permissions: [...]")``). So the next person who
  edits that role — to rename it, to add an unrelated key — gets a 422 naming a
  permission they did not touch and cannot see in the picker, because it is no
  longer in the catalog to be shown. The role becomes uneditable by anyone who
  does not already know it must be surgically removed first. That is a support
  ticket that reads like a bug in the role editor.

So the removal of the keys and the repair of the rows holding them are ONE
change, and this migration is the second half of it.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It does not delete any role, and it does not touch a role that held nothing else
— a role reduced to zero permissions is left in place, empty. Deciding that such
a role is now pointless is a judgement about how an operator organises their
staff, not a schema fact, and a migration is the wrong place to make it.

IRREVERSIBLE, and honestly so: ``downgrade`` cannot put the keys back, because
this does not record which roles had them. Restoring them would in any case
re-create the uneditable-role trap against a catalog that no longer defines them.
Recovering a role's old grant means reading it out of a backup.
"""

from __future__ import annotations

from alembic import op

revision = "0021_drop_dashboards_permissions"
down_revision = "0020_widen_alembic_version"
branch_labels = None
depends_on = None

RETIRED = ("dashboards.read", "dashboards.manage")


def upgrade() -> None:
    # Rebuild the array without the retired keys rather than string-editing the
    # JSON: a LIKE/REPLACE over the raw text would also corrupt a key that merely
    # CONTAINS one of these as a substring, and would leave the array's commas
    # malformed when the removed element is first or last.
    #
    # Cast through jsonb for the array operations and back to json to match the
    # column type; the round trip also normalises whitespace, which is fine
    # because nothing reads this column as text.
    op.execute(
        """
        UPDATE roles
           SET permissions = (
                 SELECT COALESCE(jsonb_agg(perm), '[]'::jsonb)::json
                   FROM jsonb_array_elements(permissions::jsonb) AS perm
                  WHERE perm #>> '{}' NOT IN ('dashboards.read', 'dashboards.manage')
               )
         WHERE permissions::jsonb ?| array['dashboards.read', 'dashboards.manage']
        """
    )

    # The runtime registry too: a satellite could have published one of these via
    # `permission.register` (permission_registrations is a second, dynamic source
    # of grantable keys — see auth/dynamic_permissions.py). Leaving a row there
    # would put the key back in the picker, which is the exact thing removing it
    # from the static catalog was meant to prevent.
    op.execute(
        "DELETE FROM permission_registrations "
        "WHERE key IN ('dashboards.read', 'dashboards.manage')"
    )


def downgrade() -> None:
    # Intentionally a no-op. See the module docstring: which roles held which key
    # is not recorded, so there is nothing to restore, and restoring a key the
    # catalog no longer defines would only re-create the uneditable-role trap.
    pass
