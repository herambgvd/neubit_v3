"use client";

// The one mutation that puts devices in a building. Every surface that assigns —
// gate 3's worklist and the IoT devices tab — goes through here, so the reads it
// makes stale are named once (see ASSIGN_INVALIDATES) and the gate strip's count
// cannot be left behind by one of them.
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { sites } from "@/lib/api/sites";
import type { AssignDevicesRequest, AssignDevicesResponse } from "@/lib/types";

import { ASSIGN_INVALIDATES } from "./assign";

export function useAssignDevices() {
  const qc = useQueryClient();
  return useMutation<AssignDevicesResponse, unknown, AssignDevicesRequest>({
    mutationFn: (body) => sites.devicePlacements.assign(body),
    onSuccess: () => {
      for (const key of ASSIGN_INVALIDATES) qc.invalidateQueries({ queryKey: [...key] });
    },
  });
}

export default useAssignDevices;
