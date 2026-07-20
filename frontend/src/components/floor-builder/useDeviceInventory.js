"use client";

// Placeable-device inventory for the floor-plan editor.
//
// Device placements are an id-only registry (the backend stores no name — device
// identity lives in the owning service), so anything that wants to show a placed
// device's name has to join it back against this inventory. Both the sidebar's
// "On floor" list and the canvas labels do that, hence the shared hook.
//
// Sources: vms (cameras + NVRs) and access-control (controllers + doors). `panel`
// (fire) drops in later — add a source + an inventory map.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { accessInventory, vmsInventory } from "@/lib/api/deviceInventory";

export function useDeviceInventory() {
  const instancesQ = useQuery({
    queryKey: ["floor-builder", "access-instances"],
    queryFn: () => accessInventory.instances(),
  });
  const doorsQ = useQuery({
    queryKey: ["floor-builder", "access-doors"],
    queryFn: () => accessInventory.doors(),
  });
  const camerasQ = useQuery({
    queryKey: ["floor-builder", "vms-cameras"],
    queryFn: () => vmsInventory.cameras(),
  });
  const nvrsQ = useQuery({
    queryKey: ["floor-builder", "vms-nvrs"],
    queryFn: () => vmsInventory.nvrs(),
  });

  const instances = instancesQ.data?.items ?? [];
  const doors = doorsQ.data?.items ?? [];
  const cameras = camerasQ.data?.items ?? [];
  const nvrDevices = nvrsQ.data?.items ?? [];

  const inventory = useMemo(() => {
    // Access controllers/panels → placeable devices. Identifier field is `id`.
    const instanceItems = instances.map((a) => ({
      device_id: a.id,
      name: a.name,
      device_type: "access_control",
      service: "access_control",
      search_ip: a.base_url || "",
    }));
    // Doors → placeable devices. Identifier field is `id`.
    const doorItems = doors.map((d) => ({
      device_id: d.id,
      name: d.name,
      device_type: "door",
      service: "access_control",
      search_ip: "",
    }));
    // Cameras → placeable devices with a FoV cone on the floor plan.
    const cameraItems = cameras.map((c) => ({
      device_id: c.id,
      name: c.name,
      device_type: "camera",
      service: "vms",
      search_ip: c.network_info?.ip || c.onvif?.host || "",
    }));
    // NVRs → placeable server-glyph devices.
    const nvrItems = nvrDevices.map((n) => ({
      device_id: n.id,
      name: n.name,
      device_type: "nvr",
      service: "vms",
      search_ip: n.host || "",
    }));
    return [...cameraItems, ...nvrItems, ...instanceItems, ...doorItems];
  }, [instances, doors, cameras, nvrDevices]);

  const inventoryById = useMemo(() => {
    const m = new Map();
    for (const d of inventory) m.set(d.device_id, d);
    return m;
  }, [inventory]);

  const loading =
    instancesQ.isLoading || doorsQ.isLoading || camerasQ.isLoading || nvrsQ.isLoading;

  return { inventory, inventoryById, loading };
}
