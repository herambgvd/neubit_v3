"use client";

// VmsPopupHost — the app-wide operator-popup consumer. Subscribes to the core
// realtime SSE bridge (useVmsPopups → `vms.popup` frames from the P5-B linkage
// popup action) and renders a small stack of floating LivePlayer cards for the
// popped cameras, bottom-right, each with the reason + dismiss/acknowledge.
// Non-intrusive (toast fires from the hook; the camera pop is dismissible) and
// capped so a burst can't cover the screen. Mounted ONCE in the app shell.
import Link from "next/link";
import { Icon } from "@iconify/react";

import { sevPreset } from "../eventLib";
import { useVmsPopups } from "../hooks/useVmsPopups";
import LivePlayer from "./LivePlayer";

export default function VmsPopupHost() {
  const { active, dismiss, acknowledge } = useVmsPopups();

  if (!active.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-3">
      {active.map((p) => {
        const sp = sevPreset(p.severity);
        return (
          <div
            key={p.key}
            className="pointer-events-auto overflow-hidden rounded-xl border border-card-border bg-card shadow-xl"
          >
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-card-border px-3 py-2">
              <span className={`h-2 w-2 rounded-full ${sp.dot}`} />
              <span className="text-xs font-semibold text-foreground">Camera popup</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>{sp.label}</span>
              <button
                type="button"
                onClick={() => dismiss(p.key)}
                title="Dismiss"
                className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:x-mark" className="text-sm" />
              </button>
            </div>

            {/* Live camera */}
            <div className="aspect-video w-full bg-black">
              <LivePlayer cameraId={p.camera_id} minimal className="h-full w-full" />
            </div>

            {/* Reason + actions */}
            <div className="space-y-2 px-3 py-2">
              <p className="line-clamp-2 text-[11px] text-muted">
                {p.reason || `${p.event_type || "Event"} on this camera`}
              </p>
              <div className="flex items-center gap-2">
                {p.event_id && p.occurred_at && (
                  <Link
                    href={`/playback?camera=${encodeURIComponent(p.camera_id)}&t=${encodeURIComponent(p.occurred_at)}`}
                    className="inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground"
                  >
                    <Icon icon="heroicons-outline:play" className="text-xs" /> Recording
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => acknowledge(p)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-semibold text-background hover:opacity-90"
                >
                  <Icon icon="heroicons-outline:check" className="text-xs" /> Acknowledge
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
