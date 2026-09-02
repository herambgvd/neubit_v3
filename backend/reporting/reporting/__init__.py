"""Neubit reporting store — the schema for the IoT readings pipeline.

This package owns the *schema* of `neubit_reporting`: the `readings` hypertable,
the `points` dimension table, the 1-minute / 1-hour continuous aggregates, and
the compression + retention policies. It does NOT write readings — the
reading-writer service (a NATS JetStream consumer) is the only writer, and it
imports the models from here so there is exactly one definition of the schema.

See the pipeline contract, §5, for why `num` and `txt` are separate columns.
"""
