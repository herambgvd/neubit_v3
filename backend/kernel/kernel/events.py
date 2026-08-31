"""NATS + JetStream event bus client, shared across neubit_v3 services.

Mirrors the platform core's ``app.core.events_nats`` so every service connects to
the same JetStream ``EVENTS`` stream (subjects: see ``EVENTS_SUBJECTS``) and publishes with a
consistent subject scheme + envelope. Cross-domain communication between core,
ingest, and workflow rides on this spine.

Subjects:  ``tenant.<id>.<domain>.<event>``  (per-tenant events)
           ``tenant.platform.<domain>.<event>``  (tenant_id is None → platform)

Envelope (JSON body of every publish):
    { event_id, tenant_id, type, occurred_at, source, payload }

Kept optional: if VE_NATS_URL is unset the client is a no-op, so a service still
runs standalone without a broker.

    from kernel.events import EventBus
    bus = EventBus(source="ingest")
    await bus.connect()
    await bus.publish(subject(tenant_id, "fire", "alarm.raised"), {"zone": 3})
    await bus.subscribe("tenant.*.fire.>", handler, durable="workflow-fire")
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import uuid
from typing import Any, Awaitable, Callable

from .config import get_settings

log = logging.getLogger("kernel.events")

# ── the EVENTS stream's subject list ─────────────────────────────────────────
# EVENTS used to capture ``tenant.>`` — literally every subject on the platform.
# That stopped being safe when the IoT bridge went live: a sensor feed on a
# stream configured ``max_msgs=-1, max_bytes=-1, max_age=0`` is an unbounded
# disk leak, and EVENTS has to stay unbounded-ish because it carries low-volume
# domain events that are worth keeping.
#
# NATS refuses overlapping subjects between two streams on one account, so the
# sensor feed cannot get its own bounded stream while EVENTS still claims
# ``tenant.>``. EVENTS is therefore narrowed to an EXPLICIT list of domains, and
# ``tenant.*.iot.>`` belongs to the bounded ``IOT_READINGS`` stream instead
# (see deploy/README-nats.md and the pipeline contract §4).
#
# ⚠ ADDING A NEW DOMAIN? Add it here, or its events are published to a subject
# no stream captures: core NATS delivery (the realtime SSE relays) still works,
# but there is no JetStream persistence and no durable consumer can be created
# on it. This list is the one place to change — kernel, core and gokernel all
# ensure the same stream.
EVENTS_STREAM = "EVENTS"
EVENTS_SUBJECTS = [
    "tenant.*.access.>",
    "tenant.*.core.>",
    "tenant.*.device.>",
    "tenant.*.erasure.>",
    "tenant.*.fire.>",
    "tenant.*.ingest.>",
    "tenant.*.notify.>",
    "tenant.*.sites.>",
    "tenant.*.tags.>",
    "tenant.*.tenant.>",
    "tenant.*.vms.>",
    "tenant.*.workflow.>",
]


# ── delivery / ack policy ────────────────────────────────────────────────────
#
# A durable JetStream subscription is at-least-once: the server holds a message
# until the consumer acknowledges it, and redelivers every AckWait until it does.
# nats-py's default `manual_ack=False` acks a message BEFORE the callback's
# outcome is known, so a handler that raises had its message acknowledged and
# discarded — the failure existed only as a log line and the event was gone. That
# is silent data loss, and it is what this bus did until this comment was written.
#
# Every durable subscription now ends in exactly one of three terminal states:
#
#   ack()   the handler returned normally, i.e. the work is durably done. Only then.
#   nak()   the handler raised; retry with exponential backoff, up to MAX_DELIVER.
#   term()  the message can never succeed (undecodable, or the retry budget is
#           spent). It is copied to EVENTS_DLQ first, so terminating is not silent
#           loss, then dropped so it stops being redelivered forever.
#
# This mirrors the Go bus in the nvr repo (gokernel/events/events.go) deliberately:
# both sides consume the same EVENTS stream and park failures in the same
# EVENTS_DLQ stream under the same `dlq.<original subject>` subject and the same
# `Nbt-Dlq-*` headers, so one dead-letter view covers both languages.
#
# THE CONTRACT FOR HANDLERS: raising is how a handler says "not done, retry me".
# A handler must not return normally until its work is durably persisted, and
# must not catch-and-swallow its own failures. It must also be IDEMPOTENT — a
# redelivery after a partial success is expected, not exceptional.
ACK_WAIT = 30.0        # seconds before JetStream redelivers an unacked message
MAX_DELIVER = 5        # retry budget before a message is dead-lettered
NAK_BASE_DELAY = 2.0   # first retry delay, in seconds; doubles per attempt
NAK_MAX_DELAY = 60.0

# A SEPARATE stream, deliberately outside the EVENTS subject allowlist above, so
# a dead letter can never be re-consumed into the loop that produced it.
DLQ_STREAM = "EVENTS_DLQ"
DLQ_SUBJECT_PREFIX = "dlq."


def _env_int(name: str, default: int) -> int:
    """An int from the environment, falling back rather than failing on rubbish.

    The same shape as the reading-writer's `_int` (`VE_IOT_STREAM_*`), so the two
    stream-limit knobs on this platform are configured the same way.
    """
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        log.warning("%s=%r is not an integer — using %s", name, raw, default)
        return default


# ── EVENTS_DLQ's limits, and who owns them ───────────────────────────────────
#
# The DLQ was created with the SAME shape that forced EVENTS to be narrowed:
# `max_msgs=-1, max_bytes=-1, max_age=0`, file storage. Unbounded, on disk,
# forever. Nothing had gone wrong with it yet only because little had been
# dead-lettered — which is not a limit, it is luck.
#
# TWO SIDES CREATE THIS STREAM, so bounding it is a coordination problem before
# it is a config change. The Go bus in the nvr repo calls `AddStream` and nothing
# else (`gokernel/events/events.go`, ensureStream): create-only, and its
# `streamExists()` treats "stream name already in use" — which is exactly what
# `AddStream` returns when an existing stream's config differs — as benign and
# returns. So Go can create this stream but can never CHANGE it.
#
# The split that follows from that, and the only one that cannot flap:
#
#   * **Python owns convergence.** This is already where EVENTS' and
#     IOT_READINGS' convergence lives, and the platform always runs Python.
#     `ensure_dlq_stream` below updates an existing stream onto these limits.
#   * **Go stays create-only and tolerant.** It never calls UpdateStream, so it
#     cannot fight this. Nothing on the Go side needs to change for the limits
#     to hold on this platform.
#
# KNOWN GAP, and it is a Go-side change this repo cannot make: `ensureStream`
# passes NO limits, so an NVR booting STANDALONE — with no Python service to
# converge behind it — creates EVENTS_DLQ unbounded and it stays that way. The
# fix there is to give the DLQ its own bounded `nats.StreamConfig` at CREATE
# time, matching the defaults below; it must NOT gain an UpdateStream call, or
# the two sides would rewrite each other's config on every restart.
#
# SIZING. The DLQ receives this bus's terminal failures plus the IoT pipelines'
# POISON — the reading-writer and the projector run `max_deliver=-1`, so their
# malformed messages are parked here explicitly (module-level `dead_letter`) on
# first delivery rather than by any redelivery budget. Poison is refusal-rate,
# not feed-rate: a healthy gateway contributes nothing, and a gateway publishing
# 100% garbage at the measured 37 msg/min is still only ~24 MB/day against 1 GiB.
# EVENTS itself holds ~137 messages / 72 KB in steady state at ~530 B an
# envelope, so 1 GiB is on the order of two million dead letters: a number a
# working system cannot reach, and a hard stop for a poison-message storm.
# AGE is the limit that will actually bind: 30 days is long enough that nobody
# loses evidence of a failure they have not looked at yet, and short enough that
# a forgotten DLQ is not a permanent disk leak. `max_msgs` stays -1 because two
# limits that both bind are one more thing to reason about for no gain.
#
# `discard: old` is NOT negotiable. With `discard: new` a full DLQ makes the
# dead-letter publish FAIL, and both buses then log "message dropped" and
# terminate the message anyway — parked messages would become lost ones. A dead
# letter queue must never become backpressure on the thing that feeds it.
DLQ_MAX_AGE_SEC = _env_int("VE_DLQ_STREAM_MAX_AGE_SEC", 30 * 24 * 3600)
DLQ_MAX_BYTES = _env_int("VE_DLQ_STREAM_MAX_BYTES", 1024**3)
DLQ_MAX_MSGS = _env_int("VE_DLQ_STREAM_MAX_MSGS", -1)


def _nak_delay(delivery: int) -> float:
    """Exponential backoff on the delivery count, capped at NAK_MAX_DELAY."""
    return min(NAK_BASE_DELAY * (2 ** max(0, delivery - 1)), NAK_MAX_DELAY)


async def dead_letter(js, msg, *, consumer: str, reason: str, delivery: int) -> bool:
    """Copy a refused message to EVENTS_DLQ under ``dlq.<original subject>``.

    The parking half of ``term()``: a message about to be terminated is published
    to the DLQ stream first, with the refusal reason in its headers, so "stop
    redelivering" never becomes "throw away". Module-level rather than a bus
    method because the IoT pipelines (reading-writer, projector) consume raw
    JetStream without an :class:`EventBus` and must park poison the SAME way —
    the ``dlq.`` subject prefix and the ``Nbt-Dlq-*`` header names below match
    the Go bus (nvr repo, ``gokernel/events``) byte for byte, so one dead-letter
    view reads both languages.

    Returns True when the message was parked. A DLQ write failure is logged
    loudly and returns False — and the caller must STILL terminate, because a
    message we cannot park is still a message we must stop redelivering.
    """
    if js is None:
        return False
    headers = {
        "Nbt-Dlq-Origin-Subject": msg.subject,
        "Nbt-Dlq-Consumer": consumer,
        "Nbt-Dlq-Deliveries": str(delivery),
        "Nbt-Dlq-Reason": reason,
        "Nbt-Dlq-At": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    try:
        await js.publish(DLQ_SUBJECT_PREFIX + msg.subject, msg.data, headers=headers)
    except Exception as e:  # noqa: BLE001 — never let a DLQ failure block the term
        log.error(
            "DLQ publish failed for %s (%s) — message dropped: %s",
            msg.subject, consumer, e,
        )
        return False
    log.error(
        "dead-lettered %s (%s) after %d deliveries: %s",
        msg.subject, consumer, delivery, reason,
    )
    return True


async def ensure_dlq_stream(js) -> None:
    """Create EVENTS_DLQ bounded, or converge an existing one onto the limits.

    Structurally identical to :func:`ensure_events_stream`, and for the same
    reason: `add_stream` only ever CREATES, so a stream that already exists — as
    this one does on every deployment that has run before today — would never
    hear about a limit change. Without the update below, bounding the DLQ would
    be a change that reaches only brand-new installations.

    Only Python converges (see the note above the limits): the Go bus creates and
    never updates, so this cannot become two services rewriting one config on
    every restart.

    Never raises: a service must still boot when JetStream is unhappy.
    """
    want = dict(
        max_age=float(DLQ_MAX_AGE_SEC),
        max_bytes=DLQ_MAX_BYTES,
        max_msgs=DLQ_MAX_MSGS,
    )
    try:
        info = await js.stream_info(DLQ_STREAM)
    except Exception:
        try:
            await js.add_stream(
                name=DLQ_STREAM,
                subjects=[DLQ_SUBJECT_PREFIX + ">"],
                # `discard` is left at its default, `old`. See the note above:
                # `new` would turn a full DLQ into a failed dead-letter publish,
                # and both buses drop the message when that publish fails.
                **want,
            )
            log.info(
                "EVENTS_DLQ created bounded (max_age=%ss max_bytes=%s max_msgs=%s)",
                DLQ_MAX_AGE_SEC, DLQ_MAX_BYTES, DLQ_MAX_MSGS,
            )
        except Exception as e:  # concurrent create by another service — fine
            log.info("EVENTS_DLQ stream ensure note: %s", e)
        return

    cfg = info.config
    drift = {
        k: v
        for k, v in want.items()
        # `max_age` comes back as a float of seconds and the others as ints, so
        # compare as floats throughout rather than trusting the types to match.
        if float(getattr(cfg, k, 0) or 0) != float(v)
    }
    if not drift:
        return
    try:
        for k, v in want.items():
            setattr(cfg, k, v)
        await js.update_stream(config=cfg)
        log.info("EVENTS_DLQ limits converged: %s", drift)
    except Exception as e:  # noqa: BLE001 — a bounded DLQ is not worth a failed boot
        log.warning("EVENTS_DLQ limit update failed: %s", e)


async def ensure_events_stream(js) -> None:
    """Create EVENTS, or converge an existing one onto :data:`EVENTS_SUBJECTS`.

    ``add_stream`` only ever CREATES — on an existing stream it raises and every
    caller here used to swallow that, so a subject-list change would never reach
    a running deployment. Update explicitly, and only when the list differs, so
    this stays a no-op on a converged stack.

    Never raises: a service must still boot when JetStream is unhappy.
    """
    try:
        info = await js.stream_info(EVENTS_STREAM)
    except Exception:
        try:
            await js.add_stream(name=EVENTS_STREAM, subjects=list(EVENTS_SUBJECTS))
        except Exception as e:  # concurrent create by another service — fine
            log.info("EVENTS stream ensure note: %s", e)
        return

    if sorted(info.config.subjects or []) != sorted(EVENTS_SUBJECTS):
        try:
            info.config.subjects = list(EVENTS_SUBJECTS)
            await js.update_stream(config=info.config)
            log.info("EVENTS stream subjects converged to %s", EVENTS_SUBJECTS)
        except Exception as e:  # e.g. it would overlap another stream
            log.warning("EVENTS stream subject update failed: %s", e)



def subject(tenant_id: str | None, domain: str, event: str) -> str:
    """Build a JetStream subject. ``tenant_id`` None → the ``platform`` namespace."""
    tid = tenant_id if tenant_id else "platform"
    return f"tenant.{tid}.{domain}.{event}"


def envelope(
    *, tenant_id: str | None, type: str, source: str, payload: dict | None = None
) -> dict:
    """The canonical event envelope every service emits."""
    return {
        "event_id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "type": type,
        "occurred_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": source,
        "payload": payload or {},
    }


class EventBus:
    """A thin JetStream client. One per service; connect at startup, close at shutdown."""

    def __init__(self, source: str = "neubit-service") -> None:
        self.source = source
        self._nc: Any = None  # nats.aio.client.Client
        self._js: Any = None  # JetStream context

    async def connect(self) -> None:
        """Connect to NATS + ensure the JetStream event stream exists. No-op if unset."""
        settings = get_settings()
        url = getattr(settings, "nats_url", None) or None
        if not url:
            log.info("NATS disabled (VE_NATS_URL unset) — events are no-ops")
            return
        try:
            import nats

            self._nc = await nats.connect(url, name=f"neubit-{self.source}")
            self._js = self._nc.jetstream()
            await ensure_events_stream(self._js)
            # The dead-letter stream a poisoned message is parked in, so `term()`
            # below is "stop redelivering" and not "throw away".
            await ensure_dlq_stream(self._js)
            log.info("NATS connected: %s", url)
        except Exception as e:  # broker down / lib missing → degrade gracefully
            log.warning("NATS connect failed (%s) — events are no-ops", e)
            self._nc = None
            self._js = None

    async def close(self) -> None:
        if self._nc is not None:
            try:
                await self._nc.drain()
            except Exception:
                pass
        self._nc = self._js = None

    async def publish(self, subj: str, payload: dict | None = None) -> None:
        """Publish an enveloped event to ``subj``. No-op if NATS is unavailable.

        The subject encodes tenant/domain/event; the envelope re-derives tenant_id
        and type (``<domain>.<event>``) from the subject for consumers.
        """
        if self._js is None:
            return
        tenant_id, type_ = _parse_subject(subj)
        body = envelope(
            tenant_id=tenant_id, type=type_, source=self.source, payload=payload
        )
        try:
            await self._js.publish(subj, json.dumps(body).encode())
        except Exception as e:
            log.warning("event publish failed on %s: %s", subj, e)

    async def subscribe(
        self,
        pattern: str,
        handler: Callable[[dict], Awaitable[None]],
        *,
        durable: str | None = None,
    ) -> None:
        """Subscribe to a subject pattern; handler receives the decoded envelope dict.

        Pass ``durable`` for an at-least-once JetStream durable consumer (survives
        restarts); omit it for an ephemeral core subscription.

        On the durable path the HANDLER'S OUTCOME IS THE ACK DECISION: returning
        normally acks, raising retries with backoff up to :data:`MAX_DELIVER` and
        then dead-letters to ``EVENTS_DLQ``. See the delivery/ack policy note above
        — a handler must not return until its work is durably persisted, must let
        its failures propagate rather than swallowing them, and must be idempotent.
        """
        if self._nc is None:
            return

        if durable is None or self._js is None:
            # Core NATS has no acks at all — at-most-once, nothing to acknowledge,
            # so a handler failure genuinely can only be logged.
            async def _ephemeral_cb(msg):
                try:
                    await handler(json.loads(msg.data.decode()))
                except Exception as e:
                    log.exception("event handler error on %s (ephemeral, dropped): %s", pattern, e)

            await self._nc.subscribe(pattern, cb=_ephemeral_cb)
            return

        from nats.js.api import AckPolicy, ConsumerConfig

        async def _cb(msg):
            await self._deliver(pattern, durable, handler, msg)

        config = ConsumerConfig(
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=ACK_WAIT,
            max_deliver=MAX_DELIVER,
        )
        # Reconcile BEFORE binding, not as a fallback on error. nats-py's
        # `js.subscribe` looks the durable up first and, when it already exists,
        # binds to it and IGNORES the `config` argument entirely — no exception,
        # no complaint, and the pre-existing `max_deliver=-1` stays. That is the
        # dangerous half of the bug: `manual_ack` alone (which is client-side and
        # does take effect) turns silent discard into an INFINITE redelivery loop,
        # because without a delivery budget nothing ever reaches `term()`. The
        # budget lives on the server-side consumer, so it has to be put there
        # explicitly on an existing durable.
        await self._reconcile_consumer(durable, pattern, config)
        await self._js.subscribe(
            pattern, cb=_cb, durable=durable, manual_ack=True, config=config
        )

    async def _reconcile_consumer(self, durable: str, pattern: str, config) -> bool:
        """Bring an existing durable onto the current ack policy. True if it changed.

        `ack_wait` and `max_deliver` are updatable in place on a live consumer, so
        this is an `add_consumer` on the same durable name rather than a delete —
        deleting would reset the ack floor and replay the whole retained backlog.

        The one case that DOES need a recreate is a durable left by a never-acking
        bug: unlimited max_deliver and an ack floor of 0 despite deliveries. Every
        backlogged message there is already past the new budget, so stamping the
        budget on would make JetStream stop redelivering them without ever handling
        or dead-lettering them — turning a redelivery loop into silent loss. Nothing
        on such a consumer was ever acked, so nothing is lost by starting it over.
        """
        try:
            info = await self._js.consumer_info(EVENTS_STREAM, durable)
        except Exception:
            return False  # does not exist yet — subscribe() will create it correctly
        if (
            info.config.max_deliver == config.max_deliver
            and info.config.ack_policy == config.ack_policy
        ):
            return False  # already converged; a no-op on a healthy stack
        try:
            never_acked = (
                getattr(info.ack_floor, "consumer_seq", 0) == 0
                and getattr(info.delivered, "consumer_seq", 0) > 0
            )
            if (info.config.max_deliver or -1) <= 0 and never_acked:
                log.warning(
                    "consumer %s (%s): legacy never-acking durable (delivered=%s ack_floor=0) — "
                    "recreating so its backlog replays once under the new ack policy",
                    durable, pattern, info.delivered.consumer_seq,
                )
                await self._js.delete_consumer(EVENTS_STREAM, durable)
                return True
            new_config = info.config
            new_config.ack_policy = config.ack_policy
            new_config.ack_wait = config.ack_wait
            new_config.max_deliver = config.max_deliver
            await self._js.add_consumer(EVENTS_STREAM, config=new_config)
            log.info(
                "consumer %s (%s): ack policy reconciled (ack_wait=%ss max_deliver=%s)",
                durable, pattern, ACK_WAIT, MAX_DELIVER,
            )
            return True
        except Exception as e:
            log.error("consumer %s (%s): could not apply ack policy: %s", durable, pattern, e)
            return False

    async def _deliver(self, pattern: str, durable: str, handler, msg) -> None:
        """Run one JetStream message through the handler into exactly one ack state."""
        try:
            delivery = int(msg.metadata.num_delivered)
        except Exception:
            delivery = 1

        try:
            env = json.loads(msg.data.decode())
        except Exception as e:
            # Undecodable now is undecodable on every redelivery. Retrying is a
            # guaranteed-losing loop, so park it and terminate immediately.
            log.error(
                "event decode error on %s (%s): %s — dead-lettering", pattern, durable, e
            )
            await self._dead_letter(msg, durable, f"decode: {e}", delivery)
            await _quiet(msg.term())
            return

        try:
            await handler(env)
        except Exception as e:
            event_id = env.get("event_id") if isinstance(env, dict) else None
            if delivery >= MAX_DELIVER:
                log.error(
                    "event handler error on %s (%s) event=%s after %d/%d deliveries: %r "
                    "— dead-lettering",
                    pattern, durable, event_id, delivery, MAX_DELIVER, e,
                )
                await self._dead_letter(msg, durable, repr(e), delivery)
                await _quiet(msg.term())
                return
            log.warning(
                "event handler error on %s (%s) event=%s delivery %d/%d: %r — retrying",
                pattern, durable, event_id, delivery, MAX_DELIVER, e,
            )
            await _quiet(msg.nak(delay=_nak_delay(delivery)))
            return

        await _quiet(msg.ack())

    async def _dead_letter(self, msg, durable: str, reason: str, delivery: int) -> None:
        """Park a refused message in EVENTS_DLQ — see the module-level helper."""
        await dead_letter(self._js, msg, consumer=durable, reason=reason, delivery=delivery)

    def is_connected(self) -> bool:
        return self._nc is not None


async def _quiet(awaitable) -> None:
    """Await an ack/nak/term, logging rather than raising if the server rejects it.

    A failed ack is worth knowing about (the message will be redelivered) but must
    not escape into the nats-py callback runner, which would only log it anyway.
    """
    try:
        await awaitable
    except Exception as e:
        log.warning("ack/nak/term failed: %s", e)


def _parse_subject(subj: str) -> tuple[str | None, str]:
    """`tenant.<id>.<domain>.<event>` → (tenant_id_or_None, "<domain>.<event>")."""
    parts = subj.split(".")
    if len(parts) >= 4 and parts[0] == "tenant":
        tid = parts[1]
        tenant_id = None if tid == "platform" else tid
        return tenant_id, ".".join(parts[2:])
    return None, subj
