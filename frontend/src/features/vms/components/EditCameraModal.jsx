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
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { CONFIG_TABS } from "../constants";
import { fromCamera, toUpdateBody, validateCamera } from "../formUtils";
import CameraConfigForm from "./CameraConfigForm";

export default function EditCameraModal({ camera, onClose, onSuccess, sites = [], floors = [], zones = [] }) {
  const [tab, setTab] = useState("live");
  const [form, setForm] = useState(() => fromCamera(camera));
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const update = useMutation({
    mutationFn: () => vms.cameras.update(camera.id, toUpdateBody(form)),
    onSuccess: () => {
      toast.success("Camera updated");
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Update failed")),
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
        <TabBar tabs={CONFIG_TABS} active={tab} onChange={setTab} className="mb-4" />
        <CameraConfigForm
          tab={tab}
          form={form}
          set={set}
          errors={errors}
          sites={sites}
          floors={floors}
          zones={zones}
          isEdit
        />
      </div>
    </Modal>
  );
}
