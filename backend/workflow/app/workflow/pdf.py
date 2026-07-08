"""Incident PDF report generator.

Ported from neubit_v2's ``instance/pdf_report.py``, adapted to the v3
``WorkflowInstance`` ORM row (``timeline`` replaces v2's ``history``; ``extra``
replaces ``metadata``; ``assignment`` is a JSON dict). Builds a single-page
summary PDF (header, identity block, transition-history table, description /
outcome) with reportlab. Returns a ``bytes`` blob the HTTP route streams as
``application/pdf``.

reportlab is imported lazily inside ``render_incident_pdf`` so the module import
never fails if the dependency is missing at import time (it is a declared dep).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .shared import InstanceStatus


def _fmt(dt: Any) -> str:
    if not dt:
        return "—"
    if isinstance(dt, str):
        return dt
    if isinstance(dt, datetime):
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    return str(dt)


def _status_color(status: str) -> str:
    mapping = {
        InstanceStatus.PENDING.value: "#f59e0b",
        InstanceStatus.ACTIVE.value: "#2563eb",
        InstanceStatus.PAUSED.value: "#f59e0b",
        InstanceStatus.RESOLVED.value: "#10b981",
        InstanceStatus.CANCELLED.value: "#94a3b8",
    }
    return mapping.get(status, "#475569")


def render_incident_pdf(instance: Any, *, sop: Any = None) -> bytes:
    """Render an incident report PDF for a ``WorkflowInstance`` ORM row.

    ``sop`` is the optional owning SOP row (used only for its name if the instance
    denormalized ``sop_name`` is absent). Returns the PDF as bytes.
    """
    import io

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    title = instance.name or f"Incident {instance.instance_id}"
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"Incident report — {title}",
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=16, leading=20)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=12, leading=16)
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9, leading=12)
    label = ParagraphStyle(
        "label", parent=styles["BodyText"], fontSize=8, leading=10,
        textColor=colors.HexColor("#64748b"),
    )

    story: list[Any] = []
    story.append(Paragraph("Incident report", h1))
    story.append(Paragraph(title, h2))
    story.append(Spacer(1, 4 * mm))

    status = str(instance.status or "")
    priority = str(instance.priority or "")
    pill_color = _status_color(status)
    status_html = (
        f'<font color="white" backColor="{pill_color}">'
        f"&nbsp;{status.upper()}&nbsp;</font>"
    )
    story.append(Paragraph(
        f"<b>Priority:</b> {priority.upper()} &nbsp;&nbsp; <b>Status:</b> {status_html}",
        body,
    ))
    story.append(Spacer(1, 4 * mm))

    sop_name = instance.sop_name or (sop.name if sop is not None else None) or "—"
    assignment = instance.assignment or {}
    rows = [
        ["Instance ID", instance.instance_id],
        ["SOP", f"{sop_name} (v{instance.sop_version or '—'})"],
        ["Site", instance.site_id or "—"],
        ["Current state", instance.current_state_name or "—"],
        ["Assignee", assignment.get("assigned_to_name") or instance.assigned_to or "—"],
        ["Created", _fmt(instance.created_at)],
        ["State entered", _fmt(instance.state_entered_at)],
        ["SLA deadline", _fmt(instance.sla_deadline)],
        ["Closed", _fmt(instance.closed_at)],
        ["Trigger event", instance.event_type or "—"],
    ]
    tbl = Table(rows, colWidths=[35 * mm, 130 * mm])
    tbl.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Helvetica", 9),
        ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#475569")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 6 * mm))

    # Transition history (v3: instance.timeline).
    story.append(Paragraph("Transition history", h2))
    history = list(instance.timeline or [])
    if not history:
        story.append(Paragraph("No transitions recorded.", label))
    else:
        data = [["When", "From", "→", "To", "By", "Notes"]]
        for h in history:
            d = h if isinstance(h, dict) else dict(h)
            data.append([
                _fmt(d.get("executed_at")),
                d.get("from_state_name") or "—",
                "→",
                d.get("to_state_name") or "—",
                d.get("executed_by_name") or d.get("executed_by") or "—",
                Paragraph((d.get("notes") or "").replace("\n", "<br/>"), body),
            ])
        col_widths = [32 * mm, 28 * mm, 6 * mm, 28 * mm, 28 * mm, 50 * mm]
        ht = Table(data, colWidths=col_widths, repeatRows=1)
        ht.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 8),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("BOX", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(ht)

    if instance.description:
        story.append(Spacer(1, 6 * mm))
        story.append(Paragraph("Description", h2))
        story.append(Paragraph(str(instance.description).replace("\n", "<br/>"), body))

    if instance.outcome:
        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph(f"<b>Outcome:</b> {instance.outcome}", body))

    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph(f"Generated {_fmt(datetime.now(timezone.utc))} UTC", label))

    doc.build(story)
    return buf.getvalue()
