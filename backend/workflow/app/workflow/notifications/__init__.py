"""Notifications — templates, channels, the outbox, device tokens, and delivery.

    models.py      notification_templates, notification_channels,
                   notifications, device_tokens
    schemas.py     request / response bodies
    service.py     NotificationService, DeviceTokenService
    router.py      /workflow/notifications (templates, channels, devices)
    templating.py  sandboxed Jinja rendering of subject + body
    connectors/    one file per delivery provider (email / webhook / push)
    push_tokens.py the DB token resolver + pruner the push connector calls
    consumer.py    NATS notify.request / vms.popup → outbox rows
    jobs.py        the outbox dispatch drain (worker beat)
    backlog.py     how much of the outbox is waiting and how much is LATE, as a
                   whole-process gauge — the counterpart the drain has no way to
                   report about itself

BELONGS HERE: the whole path a message takes — composed, queued, delivered,
retried. Before this package existed that path ran through five flat files, which
is the concrete complaint this layout answers.

A new delivery provider is a new file in ``connectors/`` registered in its
``__init__``, and nothing else. That is the shape worth protecting: do NOT add
provider branching to ``jobs.py`` or ``service.py``.

DOES NOT BELONG HERE: WHY a message was sent. The transition that enqueued it
lives in ``instances``; this package does not know or care.
"""
