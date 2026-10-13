"use client";

// Live VMS camera events off the realtime bridge (GET /api/v1/realtime/vms-events),
// as a bounded, newest-first buffer plus { connected }. The connection itself is
// the tab's one shared stream (vmsRealtime.ts): this hook subscribes to its
// `vms.event` frames and closes nothing of its own. Unsubscribes when `enabled` is
// false or on unmount.
//
// `cameraId` is optional — pass it to keep one camera's events (the Camera-events
// surface passes it when a camera filter is active). The shared stream carries
// every camera in the tenant, so the narrowing is done here.
import { useEffect, useState } from "react";

import type { VmsEventFrame } from "../types";
import { subscribeVmsRealtime } from "./vmsRealtime";

export interface UseVmsEventStreamOptions {
  cameraId?: string | null;
  enabled?: boolean;
  max?: number;
}

// Cap the live buffer so a long-lived stream can't grow unbounded.
const MAX_EVENTS = 500;

export function useVmsEventStream({ cameraId = null, enabled = true, max = MAX_EVENTS }: UseVmsEventStreamOptions = {}) {
  const [events, setEvents] = useState<VmsEventFrame[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    return subscribeVmsRealtime({
      event: "vms.event",
      onFrame: (frame) => {
        const data = frame as VmsEventFrame;
        if (cameraId && data.camera_id !== cameraId) return;
        setEvents((prev) => [data, ...prev].slice(0, max));
      },
      onConnected: setConnected,
    });
  }, [cameraId, enabled, max]);

  return { events, connected };
}

export default useVmsEventStream;
