"use client";

// Display-client kiosk (VW-D) — the FULLSCREEN, minimal-chrome surface each
// physical screen's browser opens (route /wall-display/[id]/[mid], OUTSIDE the
// (app) header/footer chrome). It renders ONLY its assigned monitor's cells
// (that monitor's own 1/4/9/16 layout) with the currently-assigned cameras
// playing live via MediaMTX (LivePlayer). It is READ-ONLY: no drag, no toolbar,
// no mutations — it just auto-syncs to the wall's shared state over the wall SSE
// (useWallState with control=false), so whatever an operator pushes appears here
// within a frame. Full-bleed near-black to match the control-room aesthetic.
//
// A tiny auto-hiding overlay (monitor name + sync dot) fades after a few seconds
// so the screen is pure video; move the mouse to bring it back.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { asItems } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useEstateCameras } from "@/features/vms/hooks/useEstateCameras";
import type { EstateCamera } from "@/features/vms/types";

import { videowall } from "./api";
import { useWallState } from "./hooks/useWallState";
import { monitorGrid, monitorGridStyle, cameraAt } from "./wallLayout";
import WallCell from "./components/WallCell";

export interface WallKioskProps {
  /** The `[id]` / `[mid]` route segments — the wall and the monitor on it. Next
   *  hands a dynamic segment through as `string | string[] | undefined`, so both
   *  are accepted in that shape and normalised once below. */
  wallId?: string | string[];
  monitorId?: string | string[];
}

export default function WallKiosk({ wallId: wallIdParam, monitorId: monitorIdParam }: WallKioskProps) {
  // Neither segment is a catch-all, so the array form never actually occurs; ""
  // for a missing id keeps every `enabled` gate and lookup reading as before.
  const wallId = (Array.isArray(wallIdParam) ? wallIdParam[0] : wallIdParam) ?? "";
  const monitorId = (Array.isArray(monitorIdParam) ? monitorIdParam[0] : monitorIdParam) ?? "";
  const { status, can } = useAuth();
  const [chromeOn, setChromeOn] = useState(true);

  // Auto-hide the overlay after inactivity; any mouse move brings it back.
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      setChromeOn(true);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setChromeOn(false), 4000);
    };
    arm();
    window.addEventListener("mousemove", arm);
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener("mousemove", arm);
    };
  }, []);

  const canView = status === "authed" && can("vms.wall.view");

  const wallQ = useQuery({
    queryKey: ["wall-kiosk", wallId],
    queryFn: () => videowall.walls.get(wallId),
    enabled: !!wallId && canView,
  });
  const monitorsQ = useQuery({
    queryKey: ["wall-kiosk-monitors", wallId],
    queryFn: () => videowall.monitors.list(wallId),
    enabled: !!wallId && canView,
  });
  // THE WHOLE ESTATE, not this service's own camera rows.
  //
  // This asked `/vms/cameras` alone. On a single-ownership estate that list is
  // empty — every camera belongs to a recorder — so the rail had nothing to drag
  // onto a monitor, and a wall already holding federated cells could not name what
  // was in them. `useEstateCameras` merges both sources and mints the composite
  // `fed:<node>:<camera>` ids that wall cells are persisted with, which is exactly
  // what WallCell resolves a cell against.
  const { cameras } = useEstateCameras();

  const monitors = useMemo(() => asItems(monitorsQ.data), [monitorsQ.data]);
  const monitor = useMemo(() => monitors.find((m) => m.id === monitorId), [monitors, monitorId]);
  const cameraById = useMemo(() => {
    const m = new Map<string, EstateCamera>();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  // Read-only shared state (control=false → no mutations exposed).
  const { state, connected } = useWallState(wallId, { enabled: !!wallId && canView });

  // ── gates ──────────────────────────────────────────────────────────────
  if (status === "loading") {
    return <KioskMessage icon="svg-spinners:180-ring" text="Connecting…" />;
  }
  if (!canView) {
    return <KioskMessage icon="heroicons-outline:lock-closed" text="Sign in with wall-view access to display this monitor." />;
  }
  if (wallQ.isLoading || monitorsQ.isLoading) {
    return <KioskMessage icon="svg-spinners:180-ring" text="Loading monitor…" />;
  }
  if (!monitor) {
    return <KioskMessage icon="heroicons:exclamation-triangle" text="Monitor not found on this wall." />;
  }

  const { capacity } = monitorGrid(monitor.layout);

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      {/* Cells — full-bleed grid, no gaps for a seamless wall look. */}
      <div className="grid min-h-0 flex-1" style={monitorGridStyle(monitor.layout)}>
        {Array.from({ length: capacity }, (_, cellIndex) => {
          const camId = cameraAt(state, monitor.id, cellIndex);
          return (
            <WallCell
              key={`${monitor.id}-${cellIndex}`}
              cellIndex={cellIndex}
              cameraId={camId}
              camera={camId ? cameraById.get(camId) : null}
              profile={capacity <= 1 ? "main" : "sub"}
              control={false}
            />
          );
        })}
      </div>

      {/* Auto-hiding identity overlay */}
      <div
        className={`pointer-events-none absolute left-3 top-3 z-30 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 backdrop-blur-xs transition-opacity duration-500 ${
          chromeOn ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
        <span className="text-xs font-medium text-white/90">{monitor.name}</span>
        <span className="text-[10px] text-white/40">{wallQ.data?.name}</span>
      </div>
    </div>
  );
}

interface KioskMessageProps {
  /** An iconify name. */
  icon: string;
  text: string;
}

function KioskMessage({ icon, text }: KioskMessageProps) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white/60">
      <Icon icon={icon} className="text-3xl" />
      <p className="text-sm">{text}</p>
    </div>
  );
}
