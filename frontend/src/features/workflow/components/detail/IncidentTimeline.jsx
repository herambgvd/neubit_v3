"use client";

// Incident history / audit timeline — vertical list of history entries with the
// action, an optional to-state badge, notes, and the actor + timestamp.
import { Badge } from "@/components/ui/kit";
import { titleize, fmtDateTime } from "@/lib/format";

export default function IncidentTimeline({ history = [] }) {
  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="px-5 py-4 border-b border-card-border">
        <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
      </header>
      <div className="px-5 py-4">
        {history.length === 0 ? (
          <p className="text-sm text-muted">No history entries yet.</p>
        ) : (
          <ol className="relative border-l border-card-border ml-2 space-y-4">
            {history.map((h, i) => (
              <li key={h.id ?? i} className="ml-4">
                <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-blue-500 border-2 border-card" />
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">
                    {h.action || h.event || h.type || "Update"}
                  </span>
                  {(h.to_state_name || h.to_state) && (
                    <Badge color="blue">→ {titleize(h.to_state_name || h.to_state)}</Badge>
                  )}
                </div>
                {(h.notes || h.note || h.message) && (
                  <p className="mt-0.5 text-xs text-muted">{h.notes || h.note || h.message}</p>
                )}
                <p className="mt-0.5 text-[11px] text-muted/70">
                  {h.actor_name || h.actor?.full_name || h.user || ""} {fmtDateTime(h.created_at || h.at || h.timestamp)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
