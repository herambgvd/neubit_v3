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
    backlog.py     how much of the outbox is waiting and how much is late, as a
                   whole-process gauge

Belongs here: the whole path a message takes — composed, queued, delivered,
retried.

A new delivery provider is a new file in ``connectors/`` registered in its
``__init__``, and nothing else. Do not add provider branching to ``jobs.py`` or
``service.py``.

Does not belong here: WHY a message was sent. That lives in ``instances``.
"""
