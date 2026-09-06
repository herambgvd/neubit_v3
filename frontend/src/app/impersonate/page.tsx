"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { tokens } from "@/lib/api";

// Impersonation landing: a super-admin's panel opens
//   http://localhost/impersonate#access=<jwt>
// The token rides in the URL *fragment* (never sent to the server, not logged)
// and becomes the in-memory operator session.
//
// The navigation to /home is CLIENT-SIDE on purpose. The access token lives in a
// module variable now, so a hard load would discard it before /home mounted.
//
// An impersonation is access-only by design — the panel mints no refresh token
// for it — so it ends when the tab is reloaded or closed. Re-open it from the
// panel; every impersonation is audited anyway.
export default function ImpersonatePage() {
  const router = useRouter();
  const [msg, setMsg] = useState("Starting session…");

  useEffect(() => {
    try {
      const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
      const access = new URLSearchParams(raw).get("access");
      if (!access) {
        setMsg("Invalid impersonation link.");
        return;
      }
      tokens.set(access);
      // Replace, so the fragment (and this page) leave the history stack.
      router.replace("/home");
    } catch {
      setMsg("Could not start the session.");
    }
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted">
      {msg}
    </div>
  );
}
