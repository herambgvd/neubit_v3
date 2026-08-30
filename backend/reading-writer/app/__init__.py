"""Reading-writer — the only thing that writes the `readings` hypertable.

Consumes `tenant.*.iot.reading.>` off the bounded `IOT_READINGS` JetStream
stream as a durable, queue-group (pull) consumer, batches, and upserts into
`neubit_reporting`. See the pipeline contract §4/§5/§6.
"""
