"""A placement must be able to hold the id of the camera being placed.

`device_id` was a UUID column because every device the table shipped with had a
UUID. A camera owned by a federated recorder does not: the estate mints
`fed:<node>:<camera>`, and that composite — not the node-side id — is what the
floor builder offers, what the video wall persists, and what `useCameraSites`
joins a placement on. At VARCHAR(36) the insert died with *value too long for
type character varying(36)*, so no camera could be placed at all.

The tests run on SQLite, which does not enforce a VARCHAR length, so inserting a
long id here would pass on a schema that fails in Postgres. The column's declared
width is therefore what is asserted — that is the thing the migration changes and
the thing Postgres enforces.
"""


from app.sites.device.models import DevicePlacement

# Two UUIDs and the prefix, exactly as `useEstateCameras` composes it.
FEDERATED_ID = "fed:003bf44a-b524-4fa6-87be-7d445d32f5bd:0cb6a000-3a66-4702-8a14-9e7e06dd775b"


def test_device_id_holds_a_federated_camera_id() -> None:
    width = DevicePlacement.__table__.c.device_id.type.length
    assert width is not None, "an unbounded device_id would not be enforced in Postgres either"
    assert width >= len(FEDERATED_ID), (
        f"device_id is VARCHAR({width}); a federated camera id is {len(FEDERATED_ID)} chars "
        "and placing one would fail in Postgres"
    )


def test_a_second_federation_hop_still_fits() -> None:
    # `fed:<node>:fed:<node>:<cam>` — what a recorder federated through another
    # would be called. Sized for now so this column is not migrated twice.
    doubled = f"fed:003bf44a-b524-4fa6-87be-7d445d32f5bd:{FEDERATED_ID}"
    assert DevicePlacement.__table__.c.device_id.type.length >= len(doubled)
