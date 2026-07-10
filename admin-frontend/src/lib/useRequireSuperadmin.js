"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { adminApi } from "@/lib/api";

/**
 * Client-side gate for the (panel) route group. The server (`require_superadmin`)
 * remains the authoritative check — this only improves UX.
 *
 * With the hardened token model the access token lives in memory (gone on reload)
 * and the refresh token is an httpOnly cookie. So we no longer gate on token
 * PRESENCE — we simply call `/auth/me`. The axios layer transparently refreshes
 * the access token from the cookie on a 401 and retries; if that fails it
 * redirects to /login.
 *
 * Returns { status, user } where status is "loading" | "ready" | "denied".
 */
export function useRequireSuperadmin() {
  const router = useRouter();

  const { data: user, isLoading, isError } = useQuery({
    queryKey: ["me"],
    queryFn: adminApi.me,
    retry: false,
    staleTime: 60_000,
  });

  const isSuperadmin = !!user?.is_superadmin;
  // A valid session that isn't a super-admin (or an auth failure the axios layer
  // couldn't recover from) must not see the panel.
  const denied = !isLoading && (isError || (user && !isSuperadmin));

  useEffect(() => {
    if (denied) router.replace("/login");
  }, [denied, router]);

  let status = "loading";
  if (!isLoading && isSuperadmin) status = "ready";
  else if (denied) status = "denied";

  return { status, user };
}
