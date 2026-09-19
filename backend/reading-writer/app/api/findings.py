"""Findings — gate 6 (ACTS): what a number that is wrong hands to the work it raises.

`GET /bi/sites/{site_id}/findings` (bi.read) lists a site's equipment findings,
and every `/bi/alerts` item carries its own. Each finding is one thing an
operator may raise work on, stated with its evidence:

    equipment_metric   an equipment-scope metric's outcome — the value with its
                       arithmetic and inputs, or the refusal with its reason
    data_fault         a slot that is `silent` or `ambiguous`: the point it
                       stands on stopped reporting, or two generations claim it
    iot_alert          a fault the gateway raised, in the gateway's own words

WHAT THIS DOES NOT DO
---------------------
* **It raises nothing.** Work lives in the workflow service, and this process
  cannot write there (services never read or write each other's databases — see
  the header of `placement_sync.py`) and does not publish anything a rule could
  turn into work. A finding is raised only when an operator presses the button:
  the console POSTs the finding's `work` block, plus the procedure they chose,
  to `POST /workflow/instances`.
* **It does not judge health.** The registry carries no pass mark — no kW/TR
  that is "too high", no band occupancy that is "too low" — so every outcome is
  a finding and its `status` says whether it is a value or a refusal. A grade
  invented here would be a number nobody stated.
* **It recomputes nothing.** The evidence is the outcome, the slot or the alert
  row AS THE READ RETURNED IT. The title and summary format those values for a
  person to read — rounding to the metric's own display precision — and the
  exact numbers ride beside them in the evidence, unrounded.

THE SOURCE KEY
--------------
The workflow service holds at most one OPEN incident per (tenant, source key),
so the key is what makes a finding raise work once. It names the FINDING, not
its current reading: a ΔT band that was 40% and is now 38% is the same finding,
and so is one that was refused and now computes. So no value, status, version or
window is in it — only what the finding is about:

    bi:equipment:<equipment_id>:metric:<metric key>
    bi:equipment:<equipment_id>:slot:<slot name>
    bi:iot_alert:<alert_id>

`metric:` and `slot:` are separate namespaces because metric keys and slot names
are both operator vocabulary and nothing stops one from being spelt like the
other. Ids, not tags: a chiller renamed from CH-1 to CH-01 still has its work.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from ..metric_registry import slots as slot_store

#: The `source` on the envelope the work carries. The incident list's Source
#: filter reads it, so "bi" is how an operator finds every incident BI raised.
SOURCE = "bi"

#: The slot states that are a fault in the DATA, as opposed to a gap in the
#: configuration. `unbound` and `unresolved` are gate 4's (BINDS) — nobody said
#: which point it is, or said it wrong — and are worked there, not raised here.
DATA_FAULT_STATES = (slot_store.SILENT, slot_store.AMBIGUOUS)

# The workflow service's column widths (`workflow_instances.name` /
# `.description`). A longer string is a database error there, so it is cut here
# — the full evidence rides untruncated in `trigger_data`.
_NAME_MAX = 512
_DESCRIPTION_MAX = 2048


def metric_key(equipment_id: str, metric: str) -> str:
    return f"{SOURCE}:equipment:{equipment_id}:metric:{metric}"


def slot_key(equipment_id: str, slot: str) -> str:
    return f"{SOURCE}:equipment:{equipment_id}:slot:{slot}"


def alert_key(alert_id: Any) -> str:
    return f"{SOURCE}:iot_alert:{alert_id}"


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _when(value: Any) -> Any:
    return value.isoformat() if isinstance(value, dt.datetime) else value


def _window(window: dict) -> dict:
    return {"start": _when(window["start"]), "end": _when(window["end"])}


def _work(key: str, kind: str, title: str, summary: str, site_id, evidence: dict) -> dict:
    """The `POST /workflow/instances` body, less the procedure the operator picks.

    Copied, not composed, by the console: `sop_id` is the only field it adds.
    """
    return {
        "source_key": key,
        "name": _cut(title, _NAME_MAX),
        "description": _cut(summary, _DESCRIPTION_MAX),
        "site_id": site_id,
        "trigger_data": {
            "source": SOURCE,
            # A person decided — the same marker the camera-event escalate path
            # writes, so the incident says how it came to exist.
            "raised_by": "operator",
            "type": f"bi.finding.{kind}",
            "payload": evidence,
        },
    }


def _finding(key, kind, status, title, summary, site_id, evidence, **subject) -> dict:
    return {
        "source_key": key,
        "kind": kind,
        "status": status,
        **subject,
        "title": title,
        "summary": summary,
        "evidence": evidence,
        "work": _work(key, kind, title, summary, site_id, evidence),
    }


# ── equipment ────────────────────────────────────────────────────────────────


def _equipment(e: dict) -> dict:
    return {k: e.get(k) for k in (
        "equipment_id", "tag", "name", "equipment_class", "system_id",
        "design", "design_units",
    )}


def _input_line(i: dict) -> str:
    unit = f" {i['unit']}" if i.get("unit") else ""
    if i.get("source") == "equipment_fact":
        return f"{i['input']} = {i['value']:g}{unit} (design fact `{i.get('fact')}`)"
    where = f" ({i['slot']} slot)" if i.get("slot") else ""
    return (f"{i['input']} = `{i.get('point_tag')}`{where}, "
            f"{i.get('aggregation', 'avg')} {i['value']:g}{unit}")


def _metric_text(e: dict, meta: dict, outcome: dict, window: dict) -> tuple[str, str]:
    label = meta.get("label") or outcome["metric"]
    tag = e["tag"]
    if outcome.get("status") == "ok" and outcome.get("value") is not None:
        precision = meta.get("precision")
        shown = (f"{outcome['value']:.{precision}f}" if isinstance(precision, int)
                 else f"{outcome['value']:g}")
        unit = f" {outcome['unit']}" if outcome.get("unit") else ""
        title = f"{tag} · {label}: {shown}{unit}"
        lines = [title, f"Working: {outcome.get('arithmetic')}"]
    else:
        title = f"{tag} · {label}: refused ({outcome.get('status')})"
        lines = [title, f"Reason: {outcome.get('reason')}"]
    inputs = outcome.get("inputs") or []
    if inputs:
        lines.append("Inputs: " + "; ".join(_input_line(i) for i in inputs))
    lines.append(f"Window: {window['start']} → {window['end']}")
    return title, "\n".join(lines)


def _slot_text(e: dict, slot: dict, window: dict) -> tuple[str, str]:
    title = f"{e['tag']} · {slot['label']} ({slot['slot']}): {slot['readiness']}"
    lines = [title, f"Reason: {slot.get('reason')}"]
    binding = slot.get("binding")
    if binding:
        lines.append(f"Bound to: `{binding['point_tag']}` on `{binding['device_tag']}`")
    point = slot.get("point")
    if point and point.get("last_seen_at") is not None:
        lines.append(f"Last reading: {_when(point['last_seen_at'])}")
    if slot.get("candidates"):
        lines.append(f"Candidates: {len(slot['candidates'])} live generation(s)")
    if slot.get("required_by"):
        lines.append("Needed by: " + ", ".join(slot["required_by"]))
    lines.append(f"Window: {window['start']} → {window['end']}")
    return title, "\n".join(lines)


def plant_findings(plant: dict) -> list[dict]:
    """Every finding on a site's plant, from the plant read's own answer.

    Takes `plant.plant()`'s return value and nothing else, so a finding can only
    say what the schematic says.
    """
    window = _window(plant["window"])
    site = {"site_id": plant["site_id"], "site_name": plant.get("site_name")}
    meta = {m["metric"]: m for m in plant.get("metrics") or []}
    equipment = [e for sy in plant.get("systems") or [] for e in sy.get("equipment") or []]
    equipment += plant.get("unassigned_equipment") or []

    out: list[dict] = []
    for e in equipment:
        eid = e["equipment_id"]
        subject = {"equipment_id": eid, "equipment_tag": e["tag"]}
        for key in sorted(e.get("metrics") or {}):
            outcome = e["metrics"][key]
            skey = metric_key(eid, key)
            title, summary = _metric_text(e, meta.get(key, {}), outcome, window)
            evidence = {
                "kind": "equipment_metric", "source_key": skey, **site,
                "equipment": _equipment(e),
                "metric": {"key": key, "version": outcome.get("version"),
                           "label": meta.get(key, {}).get("label")},
                "outcome": outcome,
                "window": window,
            }
            out.append(_finding(skey, "equipment_metric", outcome.get("status"), title,
                                summary, plant["site_id"], evidence, **subject))
        for slot in e.get("slots") or []:
            if slot["readiness"] not in DATA_FAULT_STATES:
                continue
            skey = slot_key(eid, slot["slot"])
            title, summary = _slot_text(e, slot, window)
            evidence = {
                "kind": "data_fault", "source_key": skey, **site,
                "equipment": _equipment(e),
                "slot": slot,
                "window": window,
            }
            out.append(_finding(skey, "data_fault", slot["readiness"], title, summary,
                                plant["site_id"], evidence, **subject))
    return out


# ── alerts ───────────────────────────────────────────────────────────────────


def alert_finding(row: dict) -> dict:
    """One `/bi/alerts` item as a finding. The gateway's message is quoted, not
    paraphrased — it is the one place the number that tripped the rule is stated.
    An alert carries no site (the gateway does not know one), so its work has
    none either rather than one guessed from a device."""
    skey = alert_key(row["alert_id"])
    who = row.get("device_tag") or "unknown device"
    what = " ".join(x for x in (row.get("severity"), row.get("alert_type")) if x) or "alert"
    title = f"{who} · {what}: {row.get('message') or 'no message'}"
    lines = [title]
    if row.get("point_addr"):
        lines.append(f"Point: {row['point_addr']}")
    lines.append(f"Raised: {_when(row.get('ts'))}")
    if row.get("conn_slug"):
        lines.append(f"Connection: {row['conn_slug']} ({row.get('proto') or 'unknown protocol'})")
    evidence = {"kind": "iot_alert", "source_key": skey, "alert": dict(row)}
    return {"source_key": skey,
            "work": _work(skey, "iot_alert", title, "\n".join(lines), None, evidence)}
