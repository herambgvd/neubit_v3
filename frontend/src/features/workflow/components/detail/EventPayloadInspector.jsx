"use client";

// Collapsible inspector for the raw trigger-event payload that raised the
// incident. Pretty-prints the JSON; header shows the event type.
import { useState } from "react";
import { Icon } from "@iconify/react";

export default function EventPayloadInspector({ payload, eventType }) {
  const [open, setOpen] = useState(false);
  let json = "";
  try { json = JSON.stringify(payload, null, 2); } catch { json = String(payload); }
  return (
    <div className="rounded-xl border border-card-border bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-5 py-4 text-left">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Trigger event</h3>
          {eventType && <p className="text-xs text-muted mt-0.5 font-mono">{eventType}</p>}
        </div>
        <Icon icon={open ? "heroicons-outline:chevron-up" : "heroicons-outline:chevron-down"} className="text-muted text-base shrink-0" />
      </button>
      {open && (
        <pre className="px-5 pb-4 text-xs font-mono text-muted overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto border-t border-card-border pt-4">{json}</pre>
      )}
    </div>
  );
}
