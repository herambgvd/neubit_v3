"use client";

// Placeable-device inventory for the floor-plan editor.
//
// Device placements are an id-only registry (the backend stores no name — device
// identity lives in the owning service), so anything that wants to show a placed
// device's name has to join it back against this inventory. Both the sidebar's
// "On floor" list and the canvas labels do that, hence the shared hook.
//
// Sources: vms (cameras + NVRs), access-control (controllers + doors) and iot
// (the reading store's reporting devices). `panel` (fire) drops in later — add a
// source + an inventory map, the way `iot` was added here.
//
// IOT AND THE TWO MEANINGS OF "device_type". The placement contract's
// `device_type` is a fixed enum (`camera` / `nvr` / `access_control` / `door` /
// `panel` / `sensor` / `reader` / `other`, see core `sites/shared.py`), and every
// IoT device is a `sensor` in it. But an estate of 29 IoT devices is not 29
// identical dots: BI classifies each one with a CATEGORY (`energy`, `hvac`,
// `water`, … — dashboard-builder contract §11) and an equipment kind. Those ride
// in `metadata` so the canvas glyph and the palette icon can tell a chiller from
// a meter, and so they survive a reload — a placement row is id-only, and a device
// that stops reporting drops out of this inventory entirely.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { accessInventory, iotInventory, vmsInventory } from "@/lib/api/deviceInventory";

export function useDeviceInventory() {
  const instancesQ = useQuery<any>({
    queryKey: ["floor-builder", "access-instances"],
    queryFn: () => accessInventory.instances(),
  });
  const doorsQ = useQuery<any>({
    queryKey: ["floor-builder", "access-doors"],
    queryFn: () => accessInventory.doors(),
  });
  const camerasQ = useQuery<any>({
    queryKey: ["floor-builder", "vms-cameras"],
    queryFn: () => vmsInventory.cameras(),
  });
  const nvrsQ = useQuery<any>({
    queryKey: ["floor-builder", "vms-nvrs"],
    queryFn: () => vmsInventory.nvrs(),
  });
  // Placeable only where the analytics module + bi.read are granted; a 403 must
  // leave the palette working for the other three sources rather than blanking it.
  const iotQ = useQuery<any>({
    queryKey: ["floor-builder", "iot-devices"],
    queryFn: () => iotInventory.devices().catch(() => ({ items: [] })),
  });

  const instances = instancesQ.data?.items ?? [];
  const doors = doorsQ.data?.items ?? [];
  const cameras = camerasQ.data?.items ?? [];
  const nvrDevices = nvrsQ.data?.items ?? [];
  const iotDevices = iotQ.data?.items ?? [];

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
    // IoT devices → placeable `sensor` glyphs, drawn by CATEGORY.
    //
    // A device with no `device_id` is skipped rather than placed under a made-up
    // key: `/bi/devices` groups out of `points` and can answer a null device for
    // points the gateway never attributed to one. Those are real and they are
    // simply not placeable — there is nothing to place.
    const iotItems = iotDevices
      .filter((d) => d.device_id)
      .map((d) => ({
        device_id: d.device_id,
        // The device TAG as the reading store received it. Not composed here and
        // not prettified — the label an operator recognises is the one on the
        // gateway.
        name: d.device_tag || d.device_id,
        device_type: "sensor",
        service: "iot",
        search_ip: "",
        // What it IS, for the glyph and the palette icon. Kept out of
        // `device_type` because that field is a placement enum, not a taxonomy.
        iot_category: d.category ?? null,
        iot_type: d.device_type ?? null,
        points: d.points ?? 0,
        // Persisted with the pin, so the plan still draws the right glyph for a
        // device that has since dropped out of this inventory.
        metadata: {
          iot_category: d.category ?? null,
          iot_type: d.device_type ?? null,
          device_tag: d.device_tag ?? null,
        },
      }));
    return [...cameraItems, ...nvrItems, ...instanceItems, ...doorItems, ...iotItems];
  }, [instances, doors, cameras, nvrDevices, iotDevices]);

  const inventoryById = useMemo(() => {
    const m = new Map<any, any>();
    for (const d of inventory) m.set(d.device_id, d);
    return m;
  }, [inventory]);

  const loading =
    instancesQ.isLoading ||
    doorsQ.isLoading ||
    camerasQ.isLoading ||
    nvrsQ.isLoading ||
    iotQ.isLoading;

  return { inventory, inventoryById, loading };
}
