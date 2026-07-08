"use client";

// Manual camera onboarding — a wide modal with the shared config-tab body
// (Live/Recording/ONVIF/Imaging/I/O/Advanced). Also offers "Test connection"
// (ONVIF probe) so the operator can verify reachability + auto-fill identity
// before saving. On save → POST /vms/cameras. Ported from gvd_nvr's camera form
// dialog, rethemed to v3 tokens.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { CONFIG_TABS, DEFAULT_CAMERA_FORM } from "../constants";
import { toCreateBody, validateCamera } from "../formUtils";
import CameraConfigForm from "./CameraConfigForm";

export default function OnboardCameraModal({ onClose, onSuccess, sites = [], floors = [], zones = [] }) {
  const [tab, setTab] = useState("live");
  const [form, setForm] = useState({ ...DEFAULT_CAMERA_FORM });
  const [errors, setErrors] = useState({});
  const [probe, setProbe] = useState(null); // last probe result

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const create = useMutation({
    mutationFn: () => vms.cameras.create(toCreateBody(form)),
    onSuccess: () => {
      toast.success("Camera onboarded");
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Onboard failed")),
  });

  const test = useMutation({
    mutationFn: () =>
      vms.discovery.probe({
        host: form.onvif_host || form.ip,
        port: Number(form.onvif_port) || Number(form.port) || 80,
        username: form.onvif_user || "admin",
        password: form.onvif_password || "",
        brand: form.brand,
      }),
    onSuccess: (res) => {
      setProbe(res);
      if (res.reachable) {
        toast.success(`Reachable — ${res.manufacturer || "device"} ${res.model || ""}`.trim());
        // Auto-mark PTZ capability from the probe.
        if (res.has_ptz) set({ ptz_capable: true });
      } else {
        toast.error(res.error || "Camera did not respond");
      }
    },
    onError: (e) => toast.error(apiError(e, "Probe failed")),
  });

  const submit = () => {
    const errs = validateCamera(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTab("live");
      return;
    }
    create.mutate();
  };

  const canProbe = !!(form.onvif_host || form.ip);

  return (
    <Modal
      open
      onClose={onClose}
      title="Onboard Camera"
      wide
      footer={
        <>
          <Button
            variant="secondary"
            icon="heroicons-outline:signal"
            disabled={!canProbe || test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="success" onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Onboard"}
          </Button>
        </>
      }
    >
      <div className="-mt-1">
        <TabBar tabs={CONFIG_TABS} active={tab} onChange={setTab} className="mb-4" />

        {probe && (
          <div
            className={`mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] ${
              probe.reachable
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
                : "border-red-500/20 bg-red-500/10 text-red-500"
            }`}
          >
            <Icon
              icon={probe.reachable ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"}
              className="mt-0.5 shrink-0 text-sm"
            />
            <span>
              {probe.reachable ? (
                <>
                  {probe.manufacturer} {probe.model} · fw {probe.firmware || "—"} · {probe.channel_count} channel(s)
                  {probe.has_ptz ? " · PTZ" : ""}
                  {probe.has_imaging ? " · Imaging" : ""}
                  {probe.has_events ? " · Events" : ""}
                </>
              ) : (
                probe.error || "Unreachable"
              )}
            </span>
          </div>
        )}

        <CameraConfigForm
          tab={tab}
          form={form}
          set={set}
          errors={errors}
          sites={sites}
          floors={floors}
          zones={zones}
        />
      </div>
    </Modal>
  );
}
