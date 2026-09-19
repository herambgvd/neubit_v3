"use client";

// ASSIGN TO A BUILDING — the confirmation every assignment passes through.
//
// It is handed the devices the operator ticked and nothing else. It asks for a
// building (required, never pre-picked — not even when there is exactly one),
// optionally a floor, and prints the whole list being asserted ABOVE the button
// that sends it. The button names the count and the building, so what is
// pressed is what is read.
//
// Then it shows what happened to EACH device. A count alone would hide the one
// outcome that matters most: `pin_cleared`, the device that moved buildings and
// lost the floor-plan pin it had in the old one.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { ActionButton, QuietButton } from "@/components/console";
import { Modal, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { sites } from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";
import type { AssignDevicesResponse, BiDeviceRow } from "@/lib/types";

import { assignBody, outcomeView } from "../assign";
import { PERM_FLOORS_READ } from "../constants";
import { useAssignDevices } from "../useAssignDevices";

export interface AssignDevicesProps {
  /** Exactly the devices the operator chose. Nothing is added to it here. */
  devices: BiDeviceRow[];
  open: boolean;
  onClose: () => void;
  /** Called once the server has answered, so the caller can clear its ticks. */
  onDone?: (res: AssignDevicesResponse) => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function AssignDevices({ devices, open, onClose, onDone }: Readonly<AssignDevicesProps>) {
  const { can } = useAuth();
  const mayFloor = can(PERM_FLOORS_READ);
  const [siteId, setSiteId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [result, setResult] = useState<AssignDevicesResponse | null>(null);
  // The rows as they were when the operator pressed — the list clears the
  // moment the reads refresh, and the outcome still has to name each device and
  // where it came from.
  const [sent, setSent] = useState<BiDeviceRow[]>([]);
  const assign = useAssignDevices();

  const sitesQ = useQuery({
    queryKey: ["sites", "assign-picker"],
    queryFn: () => sites.list({ limit: 500 }),
    enabled: open,
  });
  const floorsQ = useQuery({
    queryKey: ["floors", "assign-picker", siteId],
    queryFn: () => sites.floors.list({ site_id: siteId, limit: 100 }),
    enabled: open && mayFloor && !!siteId,
  });

  const siteList = sitesQ.data?.items ?? [];
  const floorList = floorsQ.data?.items ?? [];
  const site = siteList.find((s) => s.site_id === siteId) ?? null;
  const floorName = (id: string) => floorList.find((f) => f.floor_id === id)?.name ?? null;

  // A floor is offered for a move as well as a first placement. Core keeps a
  // device's existing pin when the same floor is restated, and drops it — saying
  // so through `pin_cleared` — when a different floor makes it false.
  const floorOffered = mayFloor && !!siteId;

  function close() {
    setSiteId("");
    setFloorId("");
    setResult(null);
    setSent([]);
    assign.reset();
    onClose();
  }

  function send() {
    const body = assignBody(devices, siteId, floorOffered ? floorId : null);
    if (!body) return;
    setSent(devices);
    assign.mutate(body, {
      onSuccess: (res) => {
        setResult(res);
        onDone?.(res);
      },
    });
  }

  if (result) {
    return (
      <Modal open={open} onClose={close} title="Assigned" size="wide" footer={<ActionButton onClick={close}>Done</ActionButton>}>
        <Outcome result={result} sent={sent} floorName={floorName} />
      </Modal>
    );
  }

  const body = assignBody(devices, siteId, floorOffered ? floorId : null);
  const target = site?.name ?? "…";

  return (
    <Modal
      open={open}
      onClose={close}
      title="Assign to a building"
      size="wide"
      staticBackdrop
      footer={
        <>
          <QuietButton onClick={close}>Cancel</QuietButton>
          <ActionButton onClick={send} disabled={!body || assign.isPending}>
            {assign.isPending
              ? "Assigning…"
              : site
                ? `Assign ${plural(devices.length, "device", "devices")} to ${site.name}`
                : "Choose a building"}
          </ActionButton>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Building"
          required
          placeholder={sitesQ.isLoading ? "Loading…" : "Choose a building"}
          value={siteId}
          options={siteList.map((s) => ({ value: s.site_id, label: s.name }))}
          onChange={(e) => {
            setSiteId(e.target.value);
            setFloorId("");
          }}
          error={sitesQ.error ? apiError(sitesQ.error, "Could not load the buildings") : undefined}
          hint={!sitesQ.isLoading && !sitesQ.error && !siteList.length ? "No building exists yet — create one under Sites." : undefined}
        />
        {floorOffered && (
          <Select
            label="Floor (optional)"
            placeholder="No floor"
            value={floorId}
            options={[{ value: "", label: "No floor" }, ...floorList.map((f) => ({ value: f.floor_id, label: f.name }))]}
            onChange={(e) => setFloorId(e.target.value)}
            hint="No pin is placed. Pin later on the floor plan if you want one."
          />
        )}
      </div>

      {/* THE ASSERTION, in full, before the button. */}
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[1.2px] text-nb-muted">
        {plural(devices.length, "device", "devices")} → {target}
      </p>
      <ul className="mt-1.5 max-h-72 space-y-1 overflow-y-auto" aria-label="Devices to assign">
        {devices.map((d) => {
          const moving = !!d.site_id && d.site_id !== siteId;
          return (
            <li
              key={d.device_id ?? d.device_tag}
              className="flex flex-wrap items-baseline gap-x-2 rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-1 text-[11.5px]"
            >
              <span className="font-mono text-nb-ink">{d.device_tag ?? d.device_id}</span>
              <span className="text-nb-faint">{d.category ?? "unclassified"}</span>
              {moving && (
                <span
                  className="text-nb-warn"
                  title="Moving to another building removes any floor-plan pin it has in the old one."
                >
                  moves from {d.site_name || "another building"}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {assign.isError && (
        <p className="mt-3 text-[11.5px] text-nb-crit">{apiError(assign.error, "Nothing was assigned")}</p>
      )}
    </Modal>
  );
}

/** Per-device outcomes. The pin line is never folded into a total. */
function Outcome({
  result,
  sent,
  floorName,
}: Readonly<{ result: AssignDevicesResponse; sent: BiDeviceRow[]; floorName: (id: string) => string | null }>) {
  const byId = new Map(sent.filter((d) => d.device_id).map((d) => [d.device_id as string, d]));
  const rows = result.items.map((it) => outcomeView(it, byId.get(it.device_id), floorName));
  const pins = rows.filter((r) => r.pinCleared).length;
  return (
    <div>
      <p className="text-[12px] text-nb-ink">
        {plural(result.assigned, "device", "devices")} in {result.site_name || "the building"}
        {pins > 0 && <span className="text-nb-warn"> · {plural(pins, "floor-plan pin", "floor-plan pins")} removed</span>}
      </p>
      <ul className="mt-2 space-y-1" aria-label="Outcome per device">
        {rows.map((r) => (
          <li
            key={r.deviceId}
            className={`flex flex-wrap items-baseline gap-x-2 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] ${
              r.tone === "warn"
                ? "border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.08)]"
                : "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.07)]"
            }`}
          >
            <Icon
              icon={r.tone === "warn" ? "heroicons:exclamation-triangle" : "heroicons:check-circle"}
              className={`self-center text-[13px] ${r.tone === "warn" ? "text-nb-warn" : "text-nb-good"}`}
            />
            <span className="font-mono text-nb-ink">{r.tag}</span>
            <span className="text-nb-soft">{r.verb}</span>
            <span className="text-nb-faint">{r.floor ? `on ${r.floor}` : "no floor"}</span>
            {r.pinCleared && (
              <span
                className="text-nb-warn"
                title="It was pinned on a floor plan in the building it left. That pin no longer describes where it is, so it was removed."
              >
                pin removed — re-pin on the floor plan
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
