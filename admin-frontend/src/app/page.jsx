"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Landing gate: head to the dashboard optimistically. The panel guard verifies
// the session (refreshing from the httpOnly cookie if needed) and bounces to
// /login if there is no valid super-admin session.
export default function IndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted">
      Loading…
    </div>
  );
}
