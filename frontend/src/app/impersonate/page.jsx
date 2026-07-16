"use client";

import { useEffect, useState } from "react";

import { tokens } from "@/lib/api";

// Impersonation landing: a super-admin's panel opens
//   http://localhost/impersonate#access=<jwt>
// The token rides in the URL *fragment* (never sent to the server, not logged),
// we store it as the operator session and hard-navigate to /home so the auth
// provider re-reads it on a fresh load.
export default function ImpersonatePage() {
  const [msg, setMsg] = useState("Starting session…");

  useEffect(() => {
    try {
      const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
      const access = new URLSearchParams(raw).get("access");
      if (!access) {
        setMsg("Invalid impersonation link.");
        return;
      }
      tokens.set(access, null);
      // Drop the fragment from history, then hard-load the console.
      window.location.replace("/dashboard");
    } catch {
      setMsg("Could not start the session.");
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted">
      {msg}
    </div>
  );
}
