"use client";

// Collapsible inspector for the raw trigger-event payload that raised the
// incident. Pretty-prints the JSON; header shows the event type. When the incident
// is CAMERA-origin (event_source "vision" — a camera device event fired the SOP) it
// also links back to the originating Camera event feed (the reverse of the
// "View incident" link on a camera-events row).
import { useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";

// Camera-origin incidents carry the domain source "vision" on the envelope.
const CAMERA_SOURCE = "vision";

export default function EventPayloadInspector({ payload, eventType, incident = null }) {
  const [open, setOpen] = useState(false);
  let json = "";
  try { json = JSON.stringify(payload, null, 2); } catch { json = String(payload); }

  // Reverse cross-link: only meaningful when this incident came from a camera event.
  const isCamera = incident?.event_source === CAMERA_SOURCE;
  const cameraId =
    (payload && typeof payload === "object" && payload.payload?.camera_id) || null;
  const cameraHref = isCamera
    ? `/camera-events${cameraId ? `?camera=${encodeURIComponent(cameraId)}` : ""}`
    : null;

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <div className="flex items-center justify-between gap-2 px-5 py-4">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center justify-between text-left">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Trigger event</h3>
            {eventType && <p className="text-xs text-muted mt-0.5 font-mono">{eventType}</p>}
          </div>
          <Icon icon={open ? "heroicons-outline:chevron-up" : "heroicons-outline:chevron-down"} className="text-muted text-base shrink-0" />
        </button>
        {cameraHref && (
          <Link
            href={cameraHref}
            title="Open the originating camera event feed"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:video-camera" className="text-xs" />
            Camera event
          </Link>
        )}
      </div>
      {open && (
        <pre className="px-5 pb-4 text-xs font-mono text-muted overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto border-t border-card-border pt-4">{json}</pre>
      )}
    </div>
  );
}
