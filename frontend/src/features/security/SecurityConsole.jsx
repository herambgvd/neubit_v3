"use client";

// Security console — the /config/security page frame. Two views selected by
// ?view=: the security POLICY (2FA / directory / SSO / dual-auth) and API KEYS
// (machine credentials). The header carries the Security modtab + Policy/Keys
// segment (see Header). Both are the access & security administration surface.
import { useSearchParams } from "next/navigation";

import Security from "./Security";
import ApiKeys from "@/features/core/api-keys/ApiKeys";

export default function SecurityConsole() {
  const view = useSearchParams().get("view") === "keys" ? "keys" : "policy";
  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {view === "keys" ? <ApiKeys /> : <Security />}
      </div>
    </div>
  );
}
