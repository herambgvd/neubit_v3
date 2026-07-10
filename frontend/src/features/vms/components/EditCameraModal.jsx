"use client";

// Edit an onboarded camera — the same tabbed config body as onboarding, hydrated
// from the CameraPublic row and saved via PATCH /vms/cameras/{id}. The ONVIF
// password is left blank (write-only) and only sent when the operator types a new
// one.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { CONFIG_TABS } from "../constants";
import { fromCamera, toUpdateBody, validateCamera } from "../formUtils";
import CameraConfigForm from "./CameraConfigForm";
import DeviceMaintenance from "./DeviceMaintenance";
import LivePlayer from "./LivePlayer";
import { usePlacementFloorsZones } from "../hooks/usePlacementFloorsZones";

// A "View" (live video) tab prepended to the config tabs — the camera detail's
// live surface (P2-D). The config tabs' own "live" key is the network/placement
// config; this is the actual video. A "Maintenance" tab (G7) — device/firmware
// info + reboot/NTP/password/config backup+restore — is appended at the end.
const VIEW_TAB = { key: "view", label: "View", icon: "heroicons-outline:play-circle" };
const DEVICE_TAB = { key: "device", label: "Maintenance", icon: "heroicons-outline:wrench-screwdriver" };
const DETAIL_TABS = [VIEW_TAB, ...CONFIG_TABS, DEVICE_TAB];

export default function EditCameraModal({ camera, onClose, onSuccess, sites = [], initialTab = "view" }) {
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState(() => fromCamera(camera));
  const [errors, setErrors] = useState({});
  const { can } = useAuth();
  // Cascading placement: floors of the selected site, zones of the selected floor.
  const { floors, zones } = usePlacementFloorsZones(form.site_id, form.floor_id);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const update = useMutation({
    mutationFn: () => vms.cameras.update(camera.id, toUpdateBody(form)),
    onSuccess: () => {
      toast.success("Camera updated");
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  // Manual recording controls (Recording tab) — toggle recording on the
  // MediaMTX path immediately, independent of the mode/schedule save.
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

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit — ${camera.name}`}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="-mt-1">
        <TabBar tabs={DETAIL_TABS} active={tab} onChange={setTab} className="mb-4" />
        {tab === "view" ? (
          <div className="aspect-video w-full overflow-hidden rounded-lg border border-card-border bg-black">
            <LivePlayer
              cameraId={camera.id}
              cameraName={camera.name}
              talkCapable={!!camera.talk_capable}
              canTalk={can("vms.live.view")}
              className="h-full"
            />
          </div>
        ) : tab === "device" ? (
          <DeviceMaintenance cameraId={camera.id} cameraName={camera.name} />
        ) : (
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
        )}
      </div>
    </Modal>
  );
}
