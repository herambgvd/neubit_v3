"use client";

// useEstateCameras — the ONE camera list for the whole VMS estate.
//
// There are two sources and there always will be: cameras this VMS owns rows for
// (`/vms/cameras`) and cameras a registered recorder owns, pulled up read-only
// (`/vms/federation/cameras`). Every surface that lets an operator pick a camera
// needs BOTH, and the composite ids minted here (`fed:<node>:<cam>`) are what get
// persisted into camera groups, wall cells and placements.
//
// This started life inline in Streaming.tsx. The Patterns console fetched only
// `/vms/cameras` instead, so on a federated install (the normal one — the VMS
// onboards no cameras of its own) its camera map was EMPTY: the group builder
// offered nothing to place, and a saved group's detail rendered raw
// `fed:<uuid>:<uuid>` strings where camera names belong. One merge, one place.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { asItems } from "@/lib/format";
import { vms } from "../api";

export function useEstateCameras() {
  const localQ = useQuery<any>({
    queryKey: ["vms-wall-cameras"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    refetchInterval: 20_000,
  });
  // Federated recorder cameras — cameras OWNED by registered NVR nodes, pulled up
  // read-only and streamed THROUGH each node. Merged into the same list so the
  // camera tree shows recorders as top-level branches alongside local cameras.
  const fedQ = useQuery<any>({
    queryKey: ["vms-wall-federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 30_000,
  });

  const cameras = useMemo(() => {
    const local = asItems(localQ.data);
    // Each federated camera gets a composite id (`fed:<node>:<cam>`) so it never
    // collides with a local camera id; real_id + node_id drive the node-issued
    // live source (see WallTile). Grouped under its recorder in the rail via
    // site_id/site_name = the node.
    const fed = (fedQ.data?.items || []).map((c: any) => ({
      id: `fed:${c.node_id}:${c.id}`,
      real_id: c.id,
      name: c.name,
      status: c.status,
      federated: true,
      // PTZ capability as the node reported it (public.ptz.capable) — drives the
      // wall's PTZ overlay gate; commands proxy through the node (operate-through-node).
      ptz_capable: !!(c.ptz && c.ptz.capable),
      node_id: c.node_id,
      node_name: c.node_name,
      site_id: `nvr:${c.node_id}`,
      site_name: c.node_name,
    }));
    return [...fed, ...local];
  }, [localQ.data, fedQ.data]);

  const cameraById = useMemo(() => {
    const m = new Map<any, any>();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  return {
    cameras,
    cameraById,
    localQ,
    fedQ,
    isLoading: localQ.isLoading || fedQ.isLoading,
    // BOTH must have answered before a caller may treat a missing id as deleted —
    // half a list is not an estate.
    isSuccess: localQ.isSuccess && fedQ.isSuccess,
  };
}

export default useEstateCameras;
