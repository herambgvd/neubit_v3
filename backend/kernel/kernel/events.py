"""NATS + JetStream event bus client, shared across neubit_v3 services.

Mirrors core's ``app.core.events_nats`` so every service connects to the same
JetStream ``EVENTS`` stream (subjects: see ``EVENTS_SUBJECTS``) with the same
subject scheme and envelope.

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

On a durable subscription the handler's exit is the ack decision: return acks,
raise NAKs and retries with backoff up to MAX_DELIVER then dead-letters. Raise
:class:`Unprocessable` when redelivery cannot change the outcome (tenant
mismatch, malformed payload, already-terminal record) and the message is
dead-lettered on its first delivery instead of its fifth. An unmarked exception
stays retryable, the safe default. Same semantics as the Go bus's
``events.Unprocessable`` / ``Retryable`` (nvr repo, gokernel/events).
"""

from __future__ import annotations

import datetime as dt
import json
import re
import logging
import os
import uuid
from typing import Any, Awaitable, Callable

from .config import get_settings

log = logging.getLogger("kernel.events")

# ── the EVENTS stream's subject list ─────────────────────────────────────────
# An explicit domain list, not ``tenant.>``: EVENTS is effectively unbounded
# (it keeps low-volume domain events), and NATS refuses overlapping subjects
# between streams, so the high-volume sensor feed can only get its own bounded
# IOT_READINGS stream if EVENTS stops claiming everything. ``tenant.*.iot.>``
# lives there (deploy/README-nats.md, pipeline contract §4).
#
# ⚠ Adding a domain? Add it here, or its events land on a subject no stream
# captures: core NATS delivery still works, but nothing is persisted and no
# durable consumer can be created. kernel, core and gokernel all ensure the
# same stream from this list.
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
# Durable subscriptions use manual acks. nats-py's default acks BEFORE the
# callback's outcome is known, so a raising handler loses its message silently —
# don't go back to it. Every durable delivery ends in exactly one of:
#
#   ack()   the handler returned, i.e. the work is durably done. Only then.
#   nak()   retryable error; retry with exponential backoff, up to MAX_DELIVER.
#   term()  can never succeed (undecodable, refused via `Unprocessable`, or the
#           retry budget is spent). Copied to EVENTS_DLQ first, then dropped.
#
# The Go bus (nvr repo, gokernel/events/events.go) uses the same EVENTS_DLQ
# stream, `dlq.<original subject>` subjects and `Nbt-Dlq-*` headers, so one
# dead-letter view covers both languages.
#
# Handler contract: raising means "not done, retry me". Don't return before the
# work is persisted, don't swallow your own failures, and be idempotent —
# redelivery after a partial success is expected.
ACK_WAIT = 30.0        # seconds before JetStream redelivers an unacked message
MAX_DELIVER = 5        # retry budget before a message is dead-lettered
NAK_BASE_DELAY = 2.0   # first retry delay, in seconds; doubles per attempt
NAK_MAX_DELAY = 60.0

# A SEPARATE stream, deliberately outside the EVENTS subject allowlist above, so
# a dead letter can never be re-consumed into the loop that produced it.
DLQ_STREAM = "EVENTS_DLQ"
DLQ_SUBJECT_PREFIX = "dlq."


# ── retryable vs. non-retryable handler failures ─────────────────────────────
#
# The retry budget is for transient failures — DB down, dependency unreachable,
# lock timeout. A failure that depends only on the message and stored state
# (tenant mismatch, missing record, terminal record, unparseable payload) fails
# identically five times and reaches the DLQ anyway, minutes late and with a
# delivery count that looks like a flaky dependency.
#
# So a handler says which kind it hit: `Unprocessable` is dead-lettered and
# terminated on the first delivery, anything else stays retryable. Retryable is
# the default because retrying a doomed message only costs latency, while
# terminating a transient one is data loss. Matches the Go bus's
# `events.Unprocessable` / `Retryable`.
class Unprocessable(Exception):
    """A handler failure that redelivery cannot change — dead-letter, don't retry.

    Raise it directly with the reason, or wrap a caught exception::

        raise Unprocessable(f"tenant_id {tid!r} is not a uuid") from exc

    `EventBus._deliver` parks the message in EVENTS_DLQ with this reason in the
    `Nbt-Dlq-Reason` header and terminates it on the current delivery. Not for a
    failure a working dependency would have made succeed — leave those a bare raise.
    """


def retryable(exc: BaseException) -> bool:
    """Whether a handler failure should be redelivered. Everything not marked
    :class:`Unprocessable` is retryable — the safe default."""
    return not isinstance(exc, Unprocessable)


def _env_int(name: str, default: int) -> int:
    """An int from the environment, falling back rather than failing on rubbish.
    Same shape as the reading-writer's `_int` (`VE_IOT_STREAM_*`)."""
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
# Two sides create this stream, so bounding it is a coordination problem. The Go
# bus (nvr repo, gokernel/events, ensureStream) is create-only and treats
# "stream name already in use" as benign, so it can create EVENTS_DLQ but never
# change it. Python therefore owns convergence — `ensure_dlq_stream` below
# updates an existing stream onto these limits — and Go must stay create-only,
# or the two would rewrite each other's config on every restart.
#
# Known gap, fixable only on the Go side: `ensureStream` passes no limits, so a
# STANDALONE NVR with no Python service behind it creates EVENTS_DLQ unbounded.
# The fix is a bounded `nats.StreamConfig` at CREATE time matching the defaults
# below — not an UpdateStream call.
#
# Sizing: the DLQ takes this bus's terminal failures plus IoT poison (the
# reading-writer and projector run `max_deliver=-1` and park malformed messages
# here directly). Poison is refusal-rate, not feed-rate — a gateway publishing
# 100% garbage at 37 msg/min is ~24 MB/day against 1 GiB, roughly two million
# dead letters at ~530 B each. Age is the limit that actually binds: 30 days
# keeps evidence around without leaking disk forever. `max_msgs` stays -1.
#
# `discard: old` is not negotiable: with `discard: new` a full DLQ makes the
# dead-letter publish fail, and both buses then drop the message. A DLQ must
# never become backpressure on what feeds it.
DLQ_MAX_AGE_SEC = _env_int("VE_DLQ_STREAM_MAX_AGE_SEC", 30 * 24 * 3600)
DLQ_MAX_BYTES = _env_int("VE_DLQ_STREAM_MAX_BYTES", 1024**3)
DLQ_MAX_MSGS = _env_int("VE_DLQ_STREAM_MAX_MSGS", -1)


def _nak_delay(delivery: int) -> float:
    """Exponential backoff on the delivery count, capped at NAK_MAX_DELAY."""
    return min(NAK_BASE_DELAY * (2 ** max(0, delivery - 1)), NAK_MAX_DELAY)


async def dead_letter(js, msg, *, consumer: str, reason: str, delivery: int) -> bool:
    """Copy a refused message to EVENTS_DLQ under ``dlq.<original subject>``.

    The parking half of ``term()``, so "stop redelivering" never means "throw
    away". Module-level rather than a bus method because the IoT pipelines
    consume raw JetStream without an :class:`EventBus` and must park poison the
    same way. The subject prefix and ``Nbt-Dlq-*`` headers match the Go bus
    (nvr repo, ``gokernel/events``) byte for byte.

    Returns True when parked. On a DLQ write failure it logs and returns False,
    and the caller must terminate anyway — an unparkable message still has to
    stop being redelivered.
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


#: EVENTS was created unbounded while the DLQ beside it was carefully limited, so
#: it grew forever — unbounded disk on an appliance, and a permanent replay archive
#: of every event ever published, including every tenant offboard. 7 days is well
#: past any consumer's redelivery budget.
EVENTS_MAX_AGE_SEC = _env_int("VE_EVENTS_MAX_AGE_SEC", 7 * 24 * 3600)
EVENTS_MAX_BYTES = _env_int("VE_EVENTS_MAX_BYTES", 4 * 1024 * 1024 * 1024)


async def ensure_dlq_stream(js) -> None:
    """Create EVENTS_DLQ bounded, or converge an existing one onto the limits.

    `add_stream` only creates, so without the explicit update a limit change
    would reach new installations only. Only Python converges — see the note
    above the limits.

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
                # `discard` stays at its default `old` — see the note above.
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
        # max_age comes back as a float, the others as ints — compare as floats.
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

    ``add_stream`` only creates and raises on an existing stream, so a
    subject-list change needs an explicit update. Only when the list differs, so
    this is a no-op on a converged stack.

    Never raises: a service must still boot when JetStream is unhappy.
    """
    want = dict(max_age=float(EVENTS_MAX_AGE_SEC), max_bytes=EVENTS_MAX_BYTES)
    try:
        info = await js.stream_info(EVENTS_STREAM)
    except Exception:
        try:
            await js.add_stream(
                name=EVENTS_STREAM, subjects=list(EVENTS_SUBJECTS), **want
            )
            log.info(
                "EVENTS created bounded (max_age=%ss max_bytes=%s)",
                EVENTS_MAX_AGE_SEC, EVENTS_MAX_BYTES,
            )
        except Exception as e:  # concurrent create by another service — fine
            log.info("EVENTS stream ensure note: %s", e)
        return

    cfg = info.config
    changed = []
    if sorted(cfg.subjects or []) != sorted(EVENTS_SUBJECTS):
        cfg.subjects = list(EVENTS_SUBJECTS)
        changed.append("subjects")
    for k, v in want.items():
        if float(getattr(cfg, k, 0) or 0) != float(v):
            setattr(cfg, k, v)
            changed.append(k)
    if not changed:
        return
    try:
        await js.update_stream(config=cfg)
        log.info("EVENTS stream converged (%s)", ", ".join(changed))
    except Exception as e:  # e.g. it would overlap another stream
        log.warning("EVENTS stream update failed: %s", e)



#: A subject token: lowercase, no dots, no wildcards. NATS gives `.` `*` and `>`
#: structural meaning, so a token carrying one changes the subject's SHAPE — which
#: is how a tenant-configured value reached another module's consumers.
_TOKEN_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class InvalidSubject(ValueError):
    """A subject token that would change the subject's shape."""


def subject(tenant_id: str | None, domain: str, event: str) -> str:
    """Build a JetStream subject. ``tenant_id`` None → the ``platform`` namespace.

    Every token is validated. `domain` in particular reaches here from
    tenant-editable configuration (ingest's category and rule `target_domain`), and
    was interpolated unchecked — so a `.` or a `>` in it published into a namespace
    the caller does not own.

    Only `domain` is validated, deliberately. It is the token that reaches here
    from tenant-editable configuration. `event` is chosen by the calling code at
    every site in the estate and may contain dots as a sub-path
    ("device", "camera.registered") — and several publishers document themselves as
    never raising, so adding a raise on their path would trade a real guarantee for
    no security gain.
    """
    tid = tenant_id if tenant_id else "platform"
    if not _TOKEN_RE.match(domain or ""):
        raise InvalidSubject(f"invalid subject domain: {domain!r}")
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


#: How long to wait between reconnect attempts, and how long a single connect
#: attempt may take. Both deliberately short: a service should not sit at boot.
RECONNECT_WAIT_SEC = _env_int("VE_NATS_RECONNECT_WAIT_SEC", 2)
CONNECT_TIMEOUT_SEC = _env_int("VE_NATS_CONNECT_TIMEOUT_SEC", 5)


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

            # nats-py reconnects on its own after a drop, but only once it has
            # connected. A service that booted while NATS was down used to publish
            # nothing and subscribe to nothing for the rest of its life, silently.
            # These options make the FIRST connect keep trying in the background.
            self._nc = await nats.connect(
                url,
                name=f"neubit-{self.source}",
                allow_reconnect=True,
                max_reconnect_attempts=-1,  # forever
                reconnect_time_wait=RECONNECT_WAIT_SEC,
                connect_timeout=CONNECT_TIMEOUT_SEC,
                error_cb=self._on_error,
                reconnected_cb=self._on_reconnected,
                disconnected_cb=self._on_disconnected,
            )
            self._js = self._nc.jetstream()
            await ensure_events_stream(self._js)
            # Where `term()` parks a poisoned message instead of dropping it.
            await ensure_dlq_stream(self._js)
            log.info("NATS connected: %s", url)
        except Exception as e:
            # Degrade rather than block boot, but say so at ERROR: with no bus this
            # service emits no events and consumes none, and that used to be a
            # single WARNING at startup and nothing afterwards.
            log.error(
                "NATS connect FAILED (%s) — this service will emit and consume no "
                "events until it is restarted with the broker reachable", e,
            )
            self._nc = None
            self._js = None

    async def _on_error(self, e: Exception) -> None:
        log.error("NATS error: %s", e)

    async def _on_disconnected(self) -> None:
        log.warning("NATS disconnected — reconnecting")

    async def _on_reconnected(self) -> None:
        log.info("NATS reconnected")

    async def close(self) -> None:
        if self._nc is not None:
            try:
                await self._nc.drain()
            except Exception:
                pass
        self._nc = self._js = None

    async def publish(self, subj: str, payload: dict | None = None) -> bool:
        """Publish an enveloped event. Returns whether it reached JetStream.

        The subject encodes tenant/domain/event; the envelope re-derives tenant_id
        and type from it, so a publisher cannot disagree with its own subject.

        Returns False rather than raising — a failed event must not roll back the
        caller's committed transaction — but it says so, and logs at ERROR. It used
        to return None on every path, so a dropped event was indistinguishable from
        a delivered one.
        """
        if self._js is None:
            log.warning("event NOT published on %s: no JetStream connection", subj)
            return False
        tenant_id, type_ = _parse_subject(subj)
        body = envelope(
            tenant_id=tenant_id, type=type_, source=self.source, payload=payload
        )
        try:
            # Nats-Msg-Id turns on JetStream dedup, so a retry after a timeout that
            # actually succeeded does not deliver the event twice.
            await self._js.publish(
                subj,
                json.dumps(body).encode(),
                headers={"Nats-Msg-Id": body["event_id"]},
            )
            return True
        except Exception as e:
            log.error("event publish FAILED on %s: %s", subj, e)
            return False

    async def subscribe(
        self,
        pattern: str,
        handler: Callable[[dict], Awaitable[None]],
        *,
        durable: str | None = None,
    ) -> None:
        """Subscribe to a subject pattern; handler receives the decoded envelope dict.

        Pass ``durable`` for an at-least-once JetStream consumer that survives
        restarts; omit it for an ephemeral core subscription.

        On the durable path the handler's outcome is the ack decision: returning
        acks, raising retries up to :data:`MAX_DELIVER` then dead-letters, and
        :class:`Unprocessable` dead-letters on the first delivery. See the
        delivery/ack policy note above for the handler contract.
        """
        if self._nc is None:
            return

        if durable is None or self._js is None:
            # Core NATS is at-most-once with no acks, so a failure can only be logged.
            async def _ephemeral_cb(msg):
                try:
                    env = json.loads(msg.data.decode())
                    mismatch = _tenant_mismatch(msg.subject, env)
                    if mismatch:
                        log.error("event on %s: %s — dropped", pattern, mismatch)
                        return
                    await handler(env)
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
        # Reconcile BEFORE binding, not as a fallback on error: `js.subscribe`
        # silently ignores `config` when the durable already exists, leaving an
        # old `max_deliver=-1` in place. `manual_ack` is client-side and does
        # take effect, so that combination is an infinite redelivery loop —
        # nothing ever reaches `term()` without a server-side delivery budget.
        await self._reconcile_consumer(durable, pattern, config)
        await self._js.subscribe(
            pattern, cb=_cb, durable=durable, manual_ack=True, config=config
        )

    async def _reconcile_consumer(self, durable: str, pattern: str, config) -> bool:
        """Bring an existing durable onto the current ack policy. True if it changed.

        `ack_wait` and `max_deliver` update in place, so this re-adds the same
        durable name rather than deleting it — a delete would reset the ack floor
        and replay the whole retained backlog.

        The one case needing a recreate is a never-acking durable (unlimited
        max_deliver, ack floor 0 despite deliveries): its backlog is already past
        the new budget, so stamping the budget on would stop redelivery without
        ever handling or dead-lettering those messages. Nothing there was acked,
        so nothing is lost by starting over.
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
            # Undecodable now is undecodable on every redelivery — park and stop.
            log.error(
                "event decode error on %s (%s): %s — dead-lettering", pattern, durable, e
            )
            await self._dead_letter(msg, durable, f"decode: {e}", delivery)
            await _quiet(msg.term())
            return

        mismatch = _tenant_mismatch(msg.subject, env)
        if mismatch:
            # The SUBJECT is authoritative. A handler that reads tenant_id from the
            # body — kernel.lifecycle's erase does — would otherwise act on whatever
            # the publisher wrote there, on a bus where nothing checks the two agree.
            # Refuse on delivery 1: redelivery cannot make them agree.
            log.error(
                "event on %s (%s): %s — refusing, dead-lettering", pattern, durable, mismatch
            )
            await self._dead_letter(msg, durable, f"tenant mismatch: {mismatch}", delivery)
            await _quiet(msg.term())
            return

        try:
            await handler(env)
        except Unprocessable as e:
            # The handler says redelivery won't help — park it on delivery 1.
            event_id = env.get("event_id") if isinstance(env, dict) else None
            log.error(
                "event handler REFUSED %s (%s) event=%s on delivery %d: %s — "
                "not retryable, dead-lettering now",
                pattern, durable, event_id, delivery, e,
            )
            await self._dead_letter(msg, durable, f"unprocessable: {e}", delivery)
            await _quiet(msg.term())
            return
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

    A failed ack matters (the message gets redelivered) but must not escape into
    the nats-py callback runner, which would only log it anyway.
    """
    try:
        await awaitable
    except Exception as e:
        log.warning("ack/nak/term failed: %s", e)


def _tenant_mismatch(subject: str, env: Any) -> str | None:
    """A description of how the subject and body disagree about the tenant, else None.

    Every publisher builds both from one id (see `subject` and `envelope`), so
    agreement is the normal case and a mismatch means the body was written by
    something other than the thing that chose the subject.
    """
    if not isinstance(env, dict):
        return None
    subject_tenant, _ = _parse_subject(subject or "")
    body_tenant = env.get("tenant_id")
    body_tenant = None if body_tenant in (None, "", "platform") else str(body_tenant)
    if subject_tenant == body_tenant:
        return None
    return f"subject says {subject_tenant!r}, body says {body_tenant!r}"


def _parse_subject(subj: str) -> tuple[str | None, str]:
    """`tenant.<id>.<domain>.<event>` → (tenant_id_or_None, "<domain>.<event>")."""
    parts = subj.split(".")
    if len(parts) >= 4 and parts[0] == "tenant":
        tid = parts[1]
        tenant_id = None if tid == "platform" else tid
        return tenant_id, ".".join(parts[2:])
    return None, subj
