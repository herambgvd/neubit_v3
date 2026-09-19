"use client";

// Which building a gateway device is in — and the way to say so, from the device.
//
// The usability gap this closes: an operator looking at a device on the gateway
// had no way to put it in a building from there. The fleet side knows the device
// by its tag; a placement is keyed by the reading store's `device_id`, so the
// line first RESOLVES the device (see `matchBiDevice`) and only offers the write
// when exactly one device is the answer. An ambiguous tag is said, not guessed.
//
// The write is the same confirmation gate 3's worklist uses (AssignDevices): one
// building picked by the operator, a floor optional, the device named before the
// button, the outcome — `pin_cleared` included — shown after. Two entry points,
// one write, one set of reads it refreshes.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";
import type { BiDeviceRow } from "@/lib/types";
import { bi } from "@/features/bi/api";
import AssignDevices from "@/features/bi/components/AssignDevices";
import { MODULE, PERM_ASSIGN, PERM_READ, PERM_SITES_READ } from "@/features/bi/constants";

import { matchBiDevice } from "./selectors";

const UNRESOLVED: Record<string, string> = {
  missing: "This device is not in the reading store's device list, so it cannot be placed from here.",
  "no-id": "The reading store holds this device with no id, so it cannot be placed.",
  ambiguous: "More than one device in the reading store carries this tag, and its points do not settle which one this is.",
};

export default function DeviceBuilding({
  gatewayId,
  tag,
  pointIds,
}: Readonly<{ gatewayId: string; tag: string; pointIds: string[] }>) {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const mayAssign = mayRead && can(PERM_ASSIGN) && can(PERM_SITES_READ);
  const [open, setOpen] = useState(false);

  const q = useQuery({
    // Under `bi-devices`, so an assignment from ANY surface refreshes this line.
    queryKey: ["bi-devices", "by-tag", gatewayId, tag],
    queryFn: async () => {
      const list = await bi.devices({ search: tag, limit: 500 });
      const items: BiDeviceRow[] = list?.items ?? [];
      const same = items.filter((d) => d.device_tag === tag && d.device_id);
      let owners: Set<string> | null = null;
      if (same.length > 1) {
        // Two devices share the tag: this one is whichever owns THESE points.
        const pts = await bi.points({ device_tag: tag, limit: 500 });
        const mine = new Set(pointIds);
        owners = new Set(
          (pts?.items ?? []).filter((p: any) => mine.has(p.point_id)).map((p: any) => p.device_id as string),
        );
      }
      return matchBiDevice(tag, items, owners);
    },
    enabled: mayRead && tag !== "(no device)",
    staleTime: 20_000,
  });

  if (!mayRead || tag === "(no device)") return null;

  if (q.isLoading) {
    return <p className="mb-2 text-[11px] text-nb-faint">Building …</p>;
  }
  if (q.isError || !q.data) {
    return <p className="mb-2 text-[11px] text-nb-faint">Building unknown — the reading store did not answer.</p>;
  }
  const { device, reason } = q.data;
  if (!device) {
    return (
      <p className="mb-2 text-[11px] text-nb-faint" title={UNRESOLVED[reason]}>
        Building unknown — {reason === "ambiguous" ? "tag is ambiguous" : "not placeable"}
      </p>
    );
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]">
      <Icon icon="heroicons:map-pin" className={`text-[13px] ${device.site_id ? "text-nb-soft" : "text-nb-warn"}`} />
      {device.site_id ? (
        <span className="text-nb-soft">
          In <span className="text-nb-ink">{device.site_name || "a building"}</span>
        </span>
      ) : (
        <span className="text-nb-warn">No building</span>
      )}
      {mayAssign && (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
          >
            {device.site_id ? "Move…" : "Assign to a building…"}
          </button>
          <AssignDevices devices={[device]} open={open} onClose={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}
