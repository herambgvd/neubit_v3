"""Report rendering (P6-B) — a report dict → CSV or PDF bytes.

The ``compute_*`` functions return a uniform report dict (``{kind, window, rows,
totals, ...}``); this module turns that into a downloadable artefact:

  * ``to_csv`` — the ``rows`` list flattened to CSV (stdlib ``csv``; trivial + dependency-
    free). A leading ``# kind / window`` comment block gives provenance.
  * ``to_pdf`` — a simple reportlab table (title + window + the rows table + a totals
    footer). reportlab is imported LAZILY so CSV/JSON keep working if the wheel is absent
    (``to_pdf`` then raises ``PdfUnavailable`` → the router 503s that one format).

Both are pure ``dict -> bytes`` (no DB / no network), so they're cheap to unit-test.
"""

from __future__ import annotations

import csv
import io
from typing import Any


class PdfUnavailable(RuntimeError):
    """reportlab is not installed → PDF export is unavailable (CSV/JSON still work)."""


def _row_columns(rows: list[dict]) -> list[str]:
    """Stable, union-of-keys column order (first row's keys first, then any extras)."""
    cols: list[str] = []
    for r in rows:
        for k in r.keys():
            if k not in cols:
                cols.append(k)
    return cols


def to_csv(report: dict[str, Any]) -> bytes:
    """Render a report's ``rows`` to CSV bytes (utf-8), with a provenance header."""
    rows = report.get("rows") or []
    out = io.StringIO()
    window = report.get("window") or {}
    out.write(f"# report: {report.get('kind')}\n")
    out.write(f"# from: {window.get('from')}\n")
    out.write(f"# to: {window.get('to')}\n")
    if not rows:
        out.write("# (no rows)\n")
        return out.getvalue().encode("utf-8")
    cols = _row_columns(rows)
    writer = csv.DictWriter(out, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({c: r.get(c, "") for c in cols})
    # Totals footer (one key=value line each) for at-a-glance summary.
    totals = report.get("totals") or {}
    if totals:
        out.write("\n")
        for k, v in totals.items():
            out.write(f"# total {k}: {v}\n")
    return out.getvalue().encode("utf-8")


def to_pdf(report: dict[str, Any]) -> bytes:
    """Render a report to a simple one-page PDF (reportlab). Raises if reportlab absent."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.platypus import (
            Paragraph,
            SimpleDocTemplate,
            Spacer,
            Table,
            TableStyle,
        )
    except Exception as exc:  # noqa: BLE001 — no reportlab → this format unavailable
        raise PdfUnavailable(str(exc)) from exc

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), title=str(report.get("kind")))
    styles = getSampleStyleSheet()
    story: list = []

    window = report.get("window") or {}
    story.append(Paragraph(f"VMS Report — {report.get('kind')}", styles["Title"]))
    story.append(Paragraph(f"Window: {window.get('from')} → {window.get('to')}", styles["Normal"]))
    story.append(Spacer(1, 12))

    rows = report.get("rows") or []
    if rows:
        cols = _row_columns(rows)
        data = [cols] + [[str(r.get(c, "")) for c in cols] for r in rows]
        table = Table(data, repeatRows=1)
        table.setStyle(
            TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")]),
            ])
        )
        story.append(table)
    else:
        story.append(Paragraph("(no rows in window)", styles["Italic"]))

    totals = report.get("totals") or {}
    if totals:
        story.append(Spacer(1, 12))
        totals_str = "  ".join(f"{k}={v}" for k, v in totals.items())
        story.append(Paragraph(f"Totals: {totals_str}", styles["Normal"]))

    doc.build(story)
    return buf.getvalue()
