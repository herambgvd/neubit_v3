"use client";

// CameraDetailView — the INLINE camera detail pane (neubit_v2 parity: the camera
// page is a two-card master/detail, and view/edit happens in the right pane, NOT a
// modal). Header (name · status · snapshot/delete/save) + the same tabbed body the
// old EditCameraModal used: View (live) · config tabs · Maintenance. Save persists
// the config form. Onboarding is still a modal (add-only).
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { CONFIG_TABS } from "../constants";
import { fromCamera, toUpdateBody, validateCamera } from "../formUtils";
import CameraConfigForm from "./CameraConfigForm";
import DeviceMaintenance from "./DeviceMaintenance";
import LivePlayer from "./LivePlayer";
import StatusBadge from "./StatusBadge";
import CodecBadge from "./CodecBadge";
import { usePlacementFloorsZones } from "../hooks/usePlacementFloorsZones";

const VIEW_TAB = { key: "view", label: "View", icon: "heroicons-outline:play-circle" };
const DEVICE_TAB = { key: "device", label: "Maintenance", icon: "heroicons-outline:wrench-screwdriver" };
const DETAIL_TABS = [VIEW_TAB, ...CONFIG_TABS, DEVICE_TAB];

export default function CameraDetailView({
  camera,
  sites = [],
  initialTab = "view",
  onUpdated,
  onDelete,
  onSnapshot,
}) {
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState(() => fromCamera(camera));
  const [errors, setErrors] = useState({});
  const { can } = useAuth();
  const { floors, zones } = usePlacementFloorsZones(form.site_id, form.floor_id);

  // Re-hydrate the form when the selected camera changes (master/detail switch).
  useEffect(() => {
    setForm(fromCamera(camera));
    setErrors({});
    setTab((t) => (t === "device" ? "view" : t)); // maintenance is camera-specific
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const update = useMutation({
    mutationFn: () => vms.cameras.update(camera.id, toUpdateBody(form)),
    onSuccess: () => {
      toast.success("Camera updated");
      onUpdated?.();
    },
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const startRec = useMutation({
    mutationFn: () => vms.recordingConfig.start(camera.id),
    onSuccess: () => toast.success("Recording started"),
    onError: (e) => toast.error(apiError(e, "Could not start recording")),
  });
  const stopRec = useMutation({
    mutationFn: () => vms.recordingConfig.stop(camera.id),
    onSuccess: () => toast.success("Recording stopped"),
    onError: (e) => toast.error(apiError(e, "Could not stop recording")),
  });

  const submit = () => {
    const errs = validateCamera(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTab("live");
      return;
    }
    update.mutate();
  };

  const cameraIp = camera.network_info?.ip || camera.onvif?.host || "—";
  const showSave = tab !== "view" && tab !== "device";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-card-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-card-border bg-hover text-muted">
            <Icon icon="heroicons-outline:video-camera" className="text-sm" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">{camera.name}</h2>
              <CodecBadge camera={camera} />
            </div>
            <p className="truncate font-mono text-[10px] text-muted">
              {cameraIp}
              {camera.nvr_id ? " · NVR channel" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={camera.status} />
          <button
            type="button"
            title="Snapshot"
            onClick={() => onSnapshot?.(camera)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:camera" className="text-base" />
          </button>
          <button
            type="button"
            title="Delete camera"
            onClick={() => onDelete?.(camera)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-card-border text-red-500 transition hover:bg-red-500/10"
          >
            <Icon icon="heroicons-outline:trash" className="text-base" />
          </button>
          {showSave && (
            <Button variant="primary" onClick={submit} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {/* Body — a flex column that fills the pane. Tabs stay fixed; the tab CONTENT
          gets the remaining height. View fills it (player letterboxes via
          object-contain → NO scroll); config/maintenance scroll internally. */}
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <TabBar tabs={DETAIL_TABS} active={tab} onChange={setTab} className="mb-3 shrink-0" />
        {tab === "view" ? (
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-card-border bg-black">
            <LivePlayer
              cameraId={camera.id}
              cameraName={camera.name}
              talkCapable={!!camera.talk_capable}
              canTalk={can("vms.live.view")}
              className="h-full"
            />
          </div>
        ) : tab === "device" ? (
          <div className="scroll-themed min-h-0 flex-1 overflow-y-auto">
            <DeviceMaintenance cameraId={camera.id} cameraName={camera.name} camera={camera} />
          </div>
        ) : (
          <div className="scroll-themed min-h-0 flex-1 overflow-y-auto">
            <CameraConfigForm
              tab={tab}
              form={form}
              set={set}
              errors={errors}
              sites={sites}
              floors={floors}
              zones={zones}
              isEdit
              cameraId={camera.id}
              cameraName={camera.name}
              onManualStart={() => startRec.mutate()}
              onManualStop={() => stopRec.mutate()}
              manualPending={startRec.isPending || stopRec.isPending}
            />
          </div>
        )}
      </div>
    </div>
  );
}
