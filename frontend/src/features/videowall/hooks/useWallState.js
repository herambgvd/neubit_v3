"use client";

// useWallState — the single source of truth for a wall's LIVE shared state on
// the operator console and the kiosk. It:
//   1. Seeds from GET /walls/{id}/state (initial paint before the first SSE frame).
//   2. Subscribes to the wall SSE (useWallStream) — every `wall.state` frame
//      REPLACES the state (shared, server-authoritative).
//   3. Exposes control mutations (push / clearCell / clearMonitor / applyPreset)
//      that call the backend; the resulting NATS→SSE frame flows back and updates
//      EVERY connected client (including this one), so we don't hand-merge —
//      the mutation response also seeds state immediately for snappy local feel.
//
// `control` gates whether mutations are allowed (vms.wall.control). The kiosk
// passes control=false and simply renders `state`.
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { videowall } from "../api";
import { useWallStream } from "./useWallStream";

export function useWallState(wallId, { enabled = true } = {}) {
  const [state, setState] = useState(null);

  // Initial snapshot (one-shot; SSE keeps it fresh afterwards).
  const stateQ = useQuery({
    queryKey: ["wall-state", wallId],
    queryFn: () => videowall.state.get(wallId),
    enabled: !!wallId && enabled,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (stateQ.data?.state && state === null) setState(stateQ.data.state);
  }, [stateQ.data, state]);

  // SSE — authoritative, replaces on every frame.
  const { state: liveState, lastFrame, connected } = useWallStream(wallId, { enabled });
  useEffect(() => {
    if (liveState) setState(liveState);
  }, [liveState]);

  // Seed state from a mutation response (before its SSE echo arrives) so the
  // acting operator sees the change instantly.
  const applyResponse = (resp) => {
    if (resp?.state) setState(resp.state);
    return resp;
  };

  const push = useCallback(
    (monitorId, cellIndex, cameraId) =>
      videowall.state
        .push(wallId, { monitor_id: monitorId, cell_index: cellIndex, camera_id: cameraId })
        .then(applyResponse),
    [wallId],
  );

  const clearCell = useCallback(
    (monitorId, cellIndex) =>
      videowall.state.clear(wallId, { monitor_id: monitorId, cell_index: cellIndex }).then(applyResponse),
    [wallId],
  );

  const clearMonitor = useCallback(
    (monitorId) => videowall.state.clear(wallId, { monitor_id: monitorId }).then(applyResponse),
    [wallId],
  );

  const applyPreset = useCallback(
    (presetId) => videowall.presets.apply(wallId, presetId).then(applyResponse),
    [wallId],
  );

  return {
    state: state || {},
    connected,
    lastFrame,
    loading: stateQ.isLoading && state === null,
    push,
    clearCell,
    clearMonitor,
    applyPreset,
    refetch: stateQ.refetch,
  };
}

export default useWallState;
