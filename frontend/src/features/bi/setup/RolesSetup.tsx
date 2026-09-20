"use client";

// Building Intelligence → Setup → WHAT EACH READING MEANS (gate 4).
//
// It used to be 494 readings in a table with a role picker per row. Only the
// roles an effective metric actually READS are worth asking about, so the screen
// now walks the devices that have something to answer, one reading at a time
// (roles/RoleAsksScreen.tsx). Stranded answers — left on a reading that stopped
// coming — stay one press away.
import { ConsolePage } from "@/components/console";
import { useAuth } from "@/lib/auth";

import { MODULE, PERM_READ } from "../constants";
import RoleAsksScreen from "./roles/RoleAsksScreen";

export default function RolesSetup() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);

  if (!mayRead) {
    return (
      <ConsolePage>
        <p className="pt-6 text-[12.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <RoleAsksScreen />
    </ConsolePage>
  );
}
