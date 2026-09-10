"""Starter playbooks — the four procedures a console needs on its first day.

WHY THIS EXISTS. An operator escalates an event into an alarm by choosing the
procedure to run. Creating an instance REQUIRES a SOP with an initial state
(``InstanceService.create`` raises otherwise), so on a fresh deployment — zero
SOPs, zero states — that choice is an empty list and the whole escalate path is a
dead end. A console cannot ask an operator to open the graph designer in the
middle of an incident.

So the deployment starts with four playbooks that cover what a recorder actually
reports, plus one catch-all for the event nobody wrote a procedure for. They are
ORDINARY SOPs: editable, renameable, deletable. Nothing reads them by id and no
behaviour depends on their existence — they are a starting point, not a fixture.

SHAPE. Every starter is the same four-node graph, because the operator's job is
the same shape every time:

    Open ──▶ Investigating ──▶ Resolved      (terminal: the incident is closed)
      └──────────┴───────────▶ Dismissed     (cancellation: it was nothing)

Both ends are reachable from both live states: an operator who recognises a false
alarm at first glance should not have to walk through "investigating" to say so.
Closing either way requires a note — an incident with no account of what happened
is a row that teaches nobody anything later.

IDEMPOTENT. Each starter carries ``starter:<slug>`` in its tags, and installing
skips any slug this tenant already has. Re-running is safe; a tenant who deleted
one on purpose gets it back only if they ask again, which is the same thing as
asking for it the first time.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..core.enums import InstancePriority

#: The tag every starter carries, so they can be found as a family.
STARTER_TAG = "starter"

#: Per-starter marker: ``starter:camera-tamper``. The idempotency key.
def slug_tag(slug: str) -> str:
    return f"{STARTER_TAG}:{slug}"


@dataclass(frozen=True)
class StarterState:
    name: str
    description: str
    color: str
    is_initial: bool = False
    is_terminal: bool = False
    is_cancellation: bool = False


@dataclass(frozen=True)
class StarterTransition:
    from_state: str
    to_state: str
    label: str
    requires_note: bool = False


@dataclass(frozen=True)
class StarterSop:
    slug: str
    name: str
    description: str
    priority: InstancePriority
    sla_hours: float
    #: Informational, and the reason it is here: the escalate picker ranks a SOP
    #: whose list contains the event's type to the top, so the common case is one
    #: click. Triggers still own automatic matching.
    event_types: list[str] = field(default_factory=list)


# The four nodes, shared by every starter. Positions are laid out for the graph
# designer so an operator opening one sees a readable diagram rather than a pile.
_STATES: tuple[StarterState, ...] = (
    StarterState(
        name="Open",
        description="Raised and waiting for someone to take it.",
        color="#F59E0B",
        is_initial=True,
    ),
    StarterState(
        name="Investigating",
        description="Somebody is looking at it right now.",
        color="#3B82F6",
    ),
    StarterState(
        name="Resolved",
        description="Dealt with. What happened is written in the note.",
        color="#10B981",
        is_terminal=True,
    ),
    StarterState(
        name="Dismissed",
        description="Not a real event — a false alarm, a test, or a known cause.",
        color="#6B7280",
        is_cancellation=True,
    ),
)

_TRANSITIONS: tuple[StarterTransition, ...] = (
    StarterTransition("Open", "Investigating", "Start investigating"),
    StarterTransition("Investigating", "Resolved", "Resolve", requires_note=True),
    StarterTransition("Investigating", "Dismissed", "Dismiss", requires_note=True),
    # Straight from Open: an operator who recognises a false alarm on sight should
    # not have to claim it first.
    StarterTransition("Open", "Dismissed", "Dismiss", requires_note=True),
    StarterTransition("Open", "Resolved", "Resolve", requires_note=True),
)

#: The layout, by state name → (x, y). Kept beside the states rather than on them
#: so the graph shape and its drawing stay separable.
_POSITIONS: dict[str, tuple[float, float]] = {
    "Open": (0.0, 0.0),
    "Investigating": (260.0, 0.0),
    "Resolved": (520.0, -80.0),
    "Dismissed": (520.0, 80.0),
}


STARTERS: tuple[StarterSop, ...] = (
    StarterSop(
        slug="camera-tamper",
        name="Camera tamper",
        description=(
            "A camera reported tampering — covered, moved, sprayed or defocused. "
            "Check the live view against what the camera used to see, then send "
            "somebody if the view really has changed."
        ),
        priority=InstancePriority.HIGH,
        sla_hours=2,
        event_types=["tamper"],
    ),
    StarterSop(
        slug="video-loss",
        name="Video loss",
        description=(
            "A camera stopped sending pictures. Check whether the recorder still "
            "reaches it, whether it is a power or network fault, and whether "
            "anything happened in the last footage before it went."
        ),
        priority=InstancePriority.HIGH,
        sla_hours=4,
        event_types=["video_loss", "camera_offline", "connection_lost"],
    ),
    StarterSop(
        slug="intrusion",
        name="Intrusion",
        description=(
            "Somebody crossed a line or entered a zone they should not be in. "
            "Verify on live video first, then follow the site's response for the "
            "area involved."
        ),
        priority=InstancePriority.CRITICAL,
        sla_hours=1,
        event_types=["line_crossing", "zone_intrusion", "intrusion"],
    ),
    StarterSop(
        slug="general",
        name="General alarm",
        description=(
            "For anything that needs following up but has no procedure of its own "
            "yet. Use it, and write a real procedure once the same thing has "
            "happened a few times."
        ),
        priority=InstancePriority.MEDIUM,
        sla_hours=4,
        event_types=[],
    ),
)


def starter_states() -> tuple[StarterState, ...]:
    return _STATES


def starter_transitions() -> tuple[StarterTransition, ...]:
    return _TRANSITIONS


def position_of(state_name: str) -> tuple[float, float]:
    return _POSITIONS.get(state_name, (0.0, 0.0))
