"use client";

// Security console — the /config/security page frame. Two views selected by
// ?view=: the security POLICY (2FA / directory / SSO / dual-auth) and API KEYS
// (machine credentials). The header carries the Security modtab + Policy/Keys
// segment (see Header). Both are the access & security administration surface.
import { useSearchParams } from "next/navigation";

import { ConsolePage, ConsoleScroll } from "@/components/console";
import Security from "./Security";
import ApiKeys from "@/features/core/api-keys/ApiKeys";

export default function SecurityConsole() {
  const view = useSearchParams().get("view") === "keys" ? "keys" : "policy";
  return (
    <ConsolePage>
      <ConsoleScroll>{view === "keys" ? <ApiKeys /> : <Security />}</ConsoleScroll>
    </ConsolePage>
  );
}
