"use client";

// A LIVE SESSION, MINTED THROUGH THE RECORDER THAT OWNS THE CAMERA.
//
// Every surface that shows live video needs the same four lines — start, renew,
// release, and the two ids that make it possible — and three of them had grown
// their own copy. One copy means one place to fix when the mint contract moves,
// and one place that knows the rule: without BOTH the node id and the camera's
// id ON that node there is no session to ask for, so the answer is null rather
// than a request that cannot succeed.
import { useMemo } from "react";

import { vms } from "../api";
import type { EstateCamera, LiveSessionSource } from "../types";

/** The recorder-side pair a session is minted from. */
export function nodeAddress(camera: EstateCamera | null): { nodeId: string; realId: string } | null {
  const nodeId = (camera as { node_id?: string } | null)?.node_id ?? null;
  const realId = (camera as { real_id?: string } | null)?.real_id ?? null;
  return nodeId && realId ? { nodeId, realId } : null;
}

/** Null when the camera is not federated — a local camera has no node to ask. */
export function nodeLiveSource(camera: EstateCamera | null): LiveSessionSource | null {
  const at = nodeAddress(camera);
  if (!at) return null;
  const mint = async (profile: string) => {
    const s = await vms.federation.live(at.nodeId, at.realId, profile);
    return { ...s, ready: true };
  };
  return {
    start: (_camId, profile) => mint(profile),
    renew: () => mint("sub"),
    release: async () => {},
  };
}

export function useNodeLiveSource(camera: EstateCamera | null): LiveSessionSource | null {
  const at = nodeAddress(camera);
  // Keyed on the ADDRESS, not the camera object: a re-fetched roster hands back a
  // new object for the same camera, and a new source tears the stream down.
  return useMemo(() => nodeLiveSource(camera), [at?.nodeId, at?.realId]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default useNodeLiveSource;
