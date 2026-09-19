"use client";

// Is there anything behind the Dashboards door on THIS deployment?
//
// DashForge is an optional peer, deliberately not merged into the default
// compose file (`deploy/docker-compose.dashforge.yml`), and a NeuBit without one
// is a supported shape. Core still serves the embed registry — the registrations
// are core's own rows — so `dashforge.read` and the `analytics` module both pass
// on a deployment where no dashboard can ever render. The launcher gated on
// exactly those two, which is why the tile was always offered and `POST
// /dashboards/{id}/session` answered the operator with a 503.
//
// The signal is the REGISTRY response the console already fetches, not a new
// endpoint: `integration_enabled` restates the deployment's existing
// VE_DASHFORGE_* config (`backend/core/app/dashforge/config.py`).
//
// It asks only whether the peer is there, NOT whether anything is registered. An
// empty registry is a legitimate state the viewer already states in words; a 503
// is not.
//
// UNKNOWN COUNTS AS AVAILABLE. While the query is in flight, or if it fails, the
// tile stays live: hiding a working surface because one request was slow is the
// worse of the two mistakes, and the page behind it says what went wrong.
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/lib/auth";

import { dashforge } from "./api";
import { MODULE, PERM_READ } from "./constants";

export function useDashForgeAvailable(): boolean {
  const { can, hasModule } = useAuth();
  const enabled = can(PERM_READ) && hasModule(MODULE);
  const q = useQuery({
    queryKey: ["dashforge", "availability"],
    queryFn: () => dashforge.list(),
    enabled,
    // The deployment's shape does not change while someone is looking at a
    // launcher; one answer per session is plenty.
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Not permitted / not entitled → `gateTile`'s own perm+module check already
  // dims the tile, so this must not also claim "unavailable".
  if (!enabled) return true;
  if (!q.isSuccess) return true;
  return q.data.integration_enabled;
}
