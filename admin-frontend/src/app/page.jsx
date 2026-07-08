"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { tokens } from "@/lib/api";

// Landing gate: bounce to the tenants console if signed in, otherwise to login.
export default function IndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(tokens.access ? "/dashboard" : "/login");
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted">
      Loading…
    </div>
  );
}
