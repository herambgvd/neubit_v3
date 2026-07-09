"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { adminApi, tokens } from "@/lib/api";

/**
 * Client-side gate for the (panel) route group. The server (`require_superadmin`)
 * remains the authoritative check — this only improves UX by:
 *   1. bouncing to /login when there is no token, and
 *   2. verifying the token actually belongs to a super-admin via /auth/me,
 *      instead of trusting token presence alone.
 *
 * Returns { status, user } where status is "loading" | "ready" | "denied".
 */
export function useRequireSuperadmin() {
  const router = useRouter();
  const hasToken = typeof window !== "undefined" && !!tokens.access;

  const { data: user, isLoading, isError } = useQuery({
    queryKey: ["me"],
    queryFn: adminApi.me,
    enabled: hasToken,
    retry: false,
    staleTime: 60_000,
  });

  const isSuperadmin = !!user?.is_superadmin;
  const denied = hasToken && !isLoading && (isError || (user && !isSuperadmin));

  useEffect(() => {
    if (!hasToken) {
      router.replace("/login");
      return;
    }
    if (denied) {
      // A valid session that isn't a super-admin should not clear the token
      // silently — but it must not see the panel. Send them to login.
      if (isError) tokens.clear();
      router.replace("/login");
    }
  }, [hasToken, denied, isError, router]);

  let status = "loading";
  if (!hasToken || denied) status = "denied";
  else if (!isLoading && isSuperadmin) status = "ready";

  return { status, user };
}
