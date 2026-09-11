"""A tenant-supplied JSON Schema must not be able to crash the receiver.

The schema on a webhook row is written by whoever holds `ingest.manage` for the
tenant. The receiver that uses it takes no JWT and is reachable from the internet.
So every malformed schema has to come back as a validation ERROR, and the code
said so — but the `except SchemaError` sat on the CONSTRUCTOR, and
`Draft202012Validator(schema)` does not check the schema at all. Measured against
jsonschema 4.26, four shapes escaped the function and became a 500 with nothing
logged:

    {"type": 123}                     TypeError
    {"$ref": "#/definitions/nope"}    _WrappedReferencingError
    {"$ref": "https://..."}           _WrappedReferencingError here — a FETCH on
                                      any host with network egress
    {"$ref": "#"}                     RecursionError

The last two are the ones that matter beyond tidiness. A remote `$ref` makes this
service issue requests of the author's choosing from inside the network; it has
been safe only because the sandbox has no egress, which is not a control. And
`{"$ref": "#"}` blows the stack on EVERY delivery for as long as the webhook
exists — one saved row, and that worker is done.
"""

from __future__ import annotations

import pytest

from app.ingest.transform import validate_payload

PAYLOAD = {"a": 1}


@pytest.mark.parametrize(
    "schema,label",
    [
        ({"type": 123}, "a non-string type"),
        ({"type": "object", "properties": {"a": {"type": ["nope"]}}}, "an unknown type"),
        ({"required": "a"}, "required as a string"),
        ({"type": "string", "pattern": "([a-z"}, "an uncompilable pattern"),
    ],
)
def test_a_malformed_schema_is_an_error_not_a_crash(schema, label):
    result = validate_payload(PAYLOAD, schema)
    assert result.ok is False, label
    assert result.errors and "invalid schema" in result.errors[0], label


@pytest.mark.parametrize(
    "ref",
    [
        "https://example.com/schema.json",
        "http://169.254.169.254/latest/meta-data/",
        "//example.com/schema.json",
        "file:///etc/passwd",
        # The four above are what a block-list would have listed. These are the
        # ones it would have missed — and the reason the check asks "is this
        # local" instead of "is this one of the schemes we thought of".
        "ftp://example.com/schema.json",
        "data:application/json,{}",
        "jar:file:///tmp/x.jar!/schema.json",
        "gopher://example.com/1",
        "schema.json",
        "/etc/passwd",
        "../sibling.json",
        "HTTPS://EXAMPLE.COM/schema.json",
    ],
)
def test_a_ref_that_leaves_the_document_is_refused(ref):
    """Not "does not resolve" — REFUSED, by name, before the validator runs.
    jsonschema 4.x resolves refs through `referencing`, which fetches on a host
    with egress. 169.254.169.254 is in the list because that is what an SSRF is
    usually aimed at."""
    result = validate_payload(PAYLOAD, {"$ref": ref})
    assert result.ok is False
    assert "$ref must stay within the document" in result.errors[0], result.errors


def test_a_remote_ref_nested_deep_in_the_schema_is_still_refused():
    """The scan has to walk the whole document, or the check is a formality."""
    schema = {
        "type": "object",
        "properties": {
            "a": {"anyOf": [{"type": "null"}, {"$ref": "https://example.com/x.json"}]}
        },
    }
    result = validate_payload(PAYLOAD, schema)
    assert result.ok is False
    assert "$ref must stay within the document" in result.errors[0]


def test_a_self_referential_ref_does_not_blow_the_stack():
    """The denial of service: one saved webhook, every delivery, forever."""
    result = validate_payload(PAYLOAD, {"$ref": "#"})
    assert result.ok is False
    assert "recursion" in result.errors[0]


def test_an_unresolvable_local_ref_is_an_error():
    result = validate_payload(PAYLOAD, {"$ref": "#/definitions/nope"})
    assert result.ok is False
    assert "invalid schema" in result.errors[0]


# ── and none of that broke the schemas that are supposed to work ─────────────

def test_no_schema_accepts_anything():
    assert validate_payload({"anything": True}, None).ok
    assert validate_payload({"anything": True}, {}).ok


def test_a_local_ref_into_defs_still_works():
    """Local `$ref` is the reason `$defs` exists; refusing it would be a
    different bug from the one being fixed."""
    schema = {
        "$defs": {"pos": {"type": "integer", "minimum": 1}},
        "type": "object",
        "properties": {"a": {"$ref": "#/$defs/pos"}},
        "required": ["a"],
    }
    assert validate_payload({"a": 1}, schema).ok
    bad = validate_payload({"a": 0}, schema)
    assert bad.ok is False
    assert "invalid schema" not in bad.errors[0], bad.errors


def test_a_real_validation_failure_still_names_the_field():
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}
    result = validate_payload({"a": 1}, schema)
    assert result.ok is False
    assert result.errors[0].startswith("a: "), result.errors


@pytest.mark.parametrize("ref", ["#", "#/$defs/thing", "#/definitions/thing", "  #/$defs/thing  "])
def test_a_local_ref_is_still_allowed(ref):
    """The other half of an allow-list: closing the door must not close it on the
    refs schemas legitimately use. A bare "#" is the document root; "#/..." is a
    pointer into it. Both stay."""
    from app.ingest.transform import _is_local_ref

    assert _is_local_ref(ref.strip()) is True


def test_the_check_is_an_allow_list_not_a_scheme_list():
    """Stated as a property, because the failure mode of a block-list is silence:
    it keeps passing while the world adds schemes it has never heard of."""
    from app.ingest.transform import _is_local_ref

    for made_up in ("weird-scheme://host/x", "x-custom:thing", "//host/x", "s3://bucket/key"):
        assert _is_local_ref(made_up) is False, made_up
