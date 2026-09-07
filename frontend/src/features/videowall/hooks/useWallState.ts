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
import type { WallState, WallStateResponse } from "../types";
import { useWallStream } from "./useWallStream";


/** Stable stand-in for "no wall state yet" — see the note at the return.*/
const EMPTY: WallState = {};

/** Options — `enabled: false` skips the seed query and the SSE subscription. */
export interface UseWallStateOptions {
  enabled?: boolean;
}

export function useWallState(
  wallId: string | null | undefined,
  { enabled = true }: UseWallStateOptions = {},
) {
  const [state, setState] = useState<WallState | null>(null);

  // Initial snapshot (one-shot; SSE keeps it fresh afterwards).
  const stateQ = useQuery<WallStateResponse>({
    queryKey: ["wall-state", wallId],
    // Guarded by `enabled` above: the query never runs without a wall id.
    queryFn: () => videowall.state.get(wallId!),
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
  const applyResponse = (resp: WallStateResponse) => {
    if (resp?.state) setState(resp.state);
    return resp;
  };

  const push = useCallback(
    (monitorId: string, cellIndex: number, cameraId: string) =>
      videowall.state
        .push(String(wallId), { monitor_id: monitorId, cell_index: cellIndex, camera_id: cameraId })
        .then(applyResponse),
    [wallId],
  );

  const clearCell = useCallback(
    (monitorId: string, cellIndex: number) =>
      videowall.state
        .clear(String(wallId), { monitor_id: monitorId, cell_index: cellIndex })
        .then(applyResponse),
    [wallId],
  );

  const clearMonitor = useCallback(
    (monitorId: string) =>
      videowall.state.clear(String(wallId), { monitor_id: monitorId }).then(applyResponse),
    [wallId],
  );

  const applyPreset = useCallback(
    (presetId: string) => videowall.presets.apply(String(wallId), presetId).then(applyResponse),
    [wallId],
  );

  return {
    // EMPTY, not `{}`: a fresh literal here changes identity on every render, so
    // every consumer memo keyed on `state` recomputed every time — which is what
    // the compiler meant by "existing memoization could not be preserved".
    state: state || EMPTY,
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
