"use client";

// System console — the /general page frame. Two views selected by ?view=: an
// Assurance posture dashboard (read-only aggregate) and the platform Settings form.
// The header carries the System modtab + Assurance/Settings segment (see Header).
import { useSearchParams } from "next/navigation";

import SystemAssurance from "./SystemAssurance";
import SettingsGeneral from "./SettingsGeneral";

export default function SystemPage() {
  const view = useSearchParams().get("view") === "settings" ? "settings" : "assurance";
  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {view === "settings" ? <SettingsGeneral /> : <SystemAssurance />}
    </div>
  );
}
