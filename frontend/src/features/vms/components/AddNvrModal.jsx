"use client";

// Add / edit an NVR (recorder) — name, brand, host/port, credentials, channel
// count. Offers a "Discover" pivot (opened from the page) but this modal is the
// manual path. On save → POST /vms/nvrs (or PATCH when editing). Credentials are
// write-only; blank on edit keeps the stored password.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { CAMERA_BRANDS } from "../constants";

export default function AddNvrModal({ nvr, onClose, onSuccess }) {
  const editing = !!nvr;
  const [form, setForm] = useState(
    editing
      ? {
          name: nvr.name || "",
          brand: nvr.brand || "onvif",
          host: nvr.host || "",
          port: nvr.port ?? 80,
          username: nvr.username || "admin",
          password: "",
          channel_count: nvr.channel_count ?? 0,
          is_enabled: nvr.is_enabled ?? true,
          has_credentials: !!nvr.has_credentials,
        }
      : { name: "", brand: "onvif", host: "", port: 80, username: "admin", password: "", channel_count: 0, is_enabled: true },
  );
  const [errors, setErrors] = useState({});
  const [probe, setProbe] = useState(null);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        brand: form.brand,
        host: form.host.trim(),
        port: Number(form.port) || 80,
        username: form.username,
        channel_count: Number(form.channel_count) || 0,
        is_enabled: !!form.is_enabled,
      };
      if (form.password) body.password = form.password;
      return editing ? vms.nvrs.update(nvr.id, body) : vms.nvrs.create(body);
    },
    onSuccess: () => { toast.success(editing ? "NVR updated" : "NVR onboarded"); onSuccess?.(); },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const test = useMutation({
    mutationFn: () =>
      vms.nvrs.probeChannels({
        host: form.host,
        port: Number(form.port) || 80,
        username: form.username,
        password: form.password || "",
        brand: form.brand,
      }),
    onSuccess: (res) => {
      const items = Array.isArray(res) ? res : res?.items || [];
      setProbe({ ok: true, count: items.length });
      if (items.length) set({ channel_count: items.length });
      toast.success(`Reachable — ${items.length} channel(s)`);
    },
    onError: (e) => { setProbe({ ok: false }); toast.error(apiError(e, "NVR did not respond")); },
  });

  const submit = () => {
    const errs = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = "Required (min 2 chars)";
    if (!form.host.trim()) errs.host = "Required";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit NVR — ${nvr.name}` : "Onboard NVR"}
      wide
      footer={
        <>
          <Button variant="secondary" icon="heroicons-outline:signal" disabled={!form.host || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant={editing ? "primary" : "success"} onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Onboard"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {probe && (
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${probe.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-500" : "border-red-500/20 bg-red-500/10 text-red-500"}`}>
            <Icon icon={probe.ok ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"} className="text-sm" />
            {probe.ok ? `Reachable — ${probe.count} channel(s) detected` : "Unreachable — check host and credentials"}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="NVR name" required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. HQ-NVR-01" error={errors.name} />
          <Field as="select" label="Brand" value={form.brand} onChange={(e) => set({ brand: e.target.value })} options={CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label }))} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Host / IP" required value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.1.10" error={errors.host} containerClassName="col-span-2" />
          <Field label="Port" type="number" value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="80" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username" value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder="admin" />
          <Field
            label="Password"
            type="password"
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
            placeholder={editing && form.has_credentials ? "•••••• (unchanged)" : "••••••••"}
            hint={editing ? "Leave blank to keep the stored credential." : undefined}
          />
        </div>
        <Field label="Channel count" type="number" value={form.channel_count} onChange={(e) => set({ channel_count: e.target.value })} hint="Auto-filled by Test connection; adjust if needed." />
      </div>
    </Modal>
  );
}
