"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { adminApi } from "@/lib/api";
import type { User } from "@/lib/types";

/** Gate state: "loading" while the session is being probed, then ready/denied. */
export type GateStatus = "loading" | "ready" | "denied";

/**
 * Client-side gate for the (panel) route group. The server (`require_superadmin`)
 * remains the authoritative check — this only improves UX.
 *
 * With the hardened token model the access token lives in memory (gone on reload)
 * and the refresh token is an httpOnly cookie. We bootstrap the session: probe
 * the refresh cookie, and only load /auth/me when a session exists — so a
 * signed-out user produces no failing requests. `bootstrap()` returns the user
 * or null.
 *
 * Returns { status, user } where status is "loading" | "ready" | "denied".
 */
export function useRequireSuperadmin(): { status: GateStatus; user: User | null | undefined } {
  const router = useRouter();

  const { data: user, isLoading } = useQuery({
    queryKey: ["session"],
    queryFn: adminApi.bootstrap,
    retry: false,
    staleTime: 60_000,
  });

  const isSuperadmin = !!user?.is_superadmin;
  // No session, or a session that isn't a super-admin, must not see the panel.
  const denied = !isLoading && !isSuperadmin;

  useEffect(() => {
    if (denied) router.replace("/login");
  }, [denied, router]);

  let status: GateStatus = "loading";
  if (!isLoading && isSuperadmin) status = "ready";
  else if (denied) status = "denied";

  return { status, user };
}
