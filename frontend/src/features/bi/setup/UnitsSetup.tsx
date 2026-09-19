"use client";

// Building Intelligence → Setup → UNITS (gate 2): say what each point measures.
// It was the UNITS tab inside Ratings; it is configuration, so it lives here.
import { useAuth } from "@/lib/auth";

import UnitsPanel from "../components/UnitsPanel";
import { MODULE, PERM_READ } from "../constants";
import SetupHeader from "./SetupHeader";

export default function UnitsSetup() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  return (
    <div className="space-y-3">
      <SetupHeader task="units" desc="suggested from the tag · stored only when a person confirms" />
      {mayRead ? (
        <UnitsPanel />
      ) : (
        <p className="text-[11.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      )}
    </div>
  );
}
