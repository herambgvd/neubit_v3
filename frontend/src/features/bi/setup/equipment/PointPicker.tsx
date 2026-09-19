"use client";

// Pick the gateway point a slot reads — a device, then one of its points — from
// what has actually REPORTED, instead of typing two tags from memory.
//
// The lists are Building Intelligence's (`/bi/devices`, `/bi/points`, served by
// the reading-writer under `bi.read` and the analytics module). The registry now
// rides the same pair, so anyone who may edit it may list; the two tag fields
// remain only for a caller the lists would refuse.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ActionButton, QuietButton, Segmented } from "@/components/console";
import { Input, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { BiDeviceListResponse, BiPointRow } from "@/lib/types";
import { bi } from "../../api";
import { MODULE, PERM_READ } from "../../constants";

export interface PickedPoint {
  device_tag: string;
  point_tag: string;
}

export interface PointPickerProps {
  siteId: string;
  busy?: boolean;
  onPick: (p: PickedPoint) => void;
  onCancel: () => void;
}

type Scope = "site" | "unplaced";

export default function PointPicker({ siteId, busy, onPick, onCancel }: Readonly<PointPickerProps>) {
  const { can, hasModule } = useAuth();
  const listable = can(PERM_READ) && hasModule(MODULE);
  const [scope, setScope] = useState<Scope>("site");
  const [device, setDevice] = useState("");
  const [point, setPoint] = useState("");

  const devicesQ = useQuery<BiDeviceListResponse>({
    queryKey: ["infra-point-devices", scope, siteId],
    queryFn: () =>
      bi.devices(scope === "site" ? { site_id: siteId, limit: 500 } : { placement: "unplaced", limit: 500 }),
    enabled: listable,
  });
  const pointsQ = useQuery<{ items: BiPointRow[] }>({
    queryKey: ["infra-point-points", device],
    queryFn: () => bi.points({ device_tag: device, with_latest: false, limit: 500 }),
    enabled: listable && !!device,
  });

  const devices = (devicesQ.data?.items ?? []).filter((d) => !!d.device_tag);
  const points = (pointsQ.data?.items ?? []).filter((p) => !!p.point_tag);
  const ready = device.trim() !== "" && point.trim() !== "";

  return (
    <div className="mt-2 space-y-2 rounded-[10px] border border-[rgba(96,165,250,.35)] bg-[rgba(96,165,250,.06)] p-3">
      {listable ? (
        <>
          <Segmented<Scope>
            value={scope}
            onChange={(v) => {
              setScope(v);
              setDevice("");
              setPoint("");
            }}
            options={[
              { value: "site", label: "This site" },
              { value: "unplaced", label: "Unplaced devices" },
            ]}
          />
          <div className="grid gap-2 md:grid-cols-2">
            <Select
              label="Device"
              value={device}
              placeholder={devicesQ.isLoading ? "Loading devices…" : devices.length ? "Pick a device" : "No devices"}
              onChange={(e) => {
                setDevice(e.target.value);
                setPoint("");
              }}
              options={devices.map((d) => ({
                value: d.device_tag as string,
                label: d.device_type ? `${d.device_tag} · ${d.device_type}` : (d.device_tag as string),
              }))}
            />
            <Select
              label="Point"
              value={point}
              disabled={!device}
              placeholder={!device ? "Pick a device first" : pointsQ.isLoading ? "Loading points…" : "Pick a point"}
              onChange={(e) => setPoint(e.target.value)}
              options={points.map((p) => ({
                value: p.point_tag as string,
                label: p.type === "text" ? `${p.point_tag} · text` : (p.point_tag as string),
              }))}
            />
          </div>
          {devicesQ.isError && (
            <p className="text-[11px] text-nb-crit">{apiError(devicesQ.error, "Could not load devices")}</p>
          )}
          {pointsQ.isError && (
            <p className="text-[11px] text-nb-crit">{apiError(pointsQ.error, "Could not load points")}</p>
          )}
          {devicesQ.data && devicesQ.data.total > devicesQ.data.items.length && (
            <p className="text-[10.5px] text-nb-faint">
              First {devicesQ.data.items.length} of {devicesQ.data.total} devices
            </p>
          )}
        </>
      ) : (
        <div
          className="grid gap-2 md:grid-cols-2"
          title="Listing points needs bi.read. Type the tags exactly as the gateway publishes them."
        >
          <Input label="Device tag" value={device} onChange={(e) => setDevice(e.target.value)} className="font-mono" />
          <Input label="Point tag" value={point} onChange={(e) => setPoint(e.target.value)} className="font-mono" />
        </div>
      )}
      <div className="flex items-center gap-2">
        <ActionButton
          disabled={!ready || busy}
          onClick={() => onPick({ device_tag: device.trim(), point_tag: point.trim() })}
        >
          {busy ? "Binding…" : "Bind"}
        </ActionButton>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
    </div>
  );
}
