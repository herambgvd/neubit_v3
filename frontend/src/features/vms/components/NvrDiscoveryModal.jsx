"use client";

// NVR discovery — LAN scan filtered to recorder-type ONVIF devices
// (POST /vms/nvrs/discover). Pick one → prefill the onboard form (host/port/brand)
// so the operator only supplies credentials + a name. Onboards via POST /vms/nvrs.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "../api";
import { CAMERA_BRANDS } from "../constants";

export default function NvrDiscoveryModal({ onClose, onSuccess }) {
  const [network, setNetwork] = useState("");
  const [brand, setBrand] = useState("");
  const [devices, setDevices] = useState([]);
  const [form, setForm] = useState(null); // { name, host, port, username, password, brand, channel_count }

  const scan = useMutation({
    mutationFn: () => vms.nvrs.discover({ network: network || undefined, brand: brand || undefined }),
    onSuccess: (res) => {
      const items = asItems(res);
      setDevices(items);
      if (!items.length) toast.message("No NVR-type devices found.");
      else toast.success(`Found ${items.length} recorder(s)`);
    },
    onError: (e) => toast.error(apiError(e, "Scan failed")),
  });

  const onboard = useMutation({
    mutationFn: () =>
      vms.nvrs.create({
        name: form.name.trim(),
        brand: form.brand,
        host: form.host,
        port: Number(form.port) || 80,
        username: form.username,
        password: form.password || undefined,
        channel_count: Number(form.channel_count) || 0,
      }),
    onSuccess: () => { toast.success("NVR onboarded"); onSuccess?.(); },
    onError: (e) => toast.error(apiError(e, "Onboard failed")),
  });

  const choose = (d) =>
    setForm({
      name: d.name || d.manufacturer || `NVR ${d.ip}`,
      host: d.ip || d.xaddr || "",
      port: d.port || 80,
      username: "admin",
      password: "",
      brand: d.brand || brand || "onvif",
      channel_count: 0,
    });

  return (
    <Modal
      open
      onClose={onClose}
      title="Discover NVR"
      wide
      footer={
        form ? (
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>Back to results</Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => onboard.mutate()} disabled={!form.host || !form.name || onboard.isPending}>
              {onboard.isPending ? "Onboarding…" : "Onboard NVR"}
            </Button>
          </>
        ) : (
          <>
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button variant="primary" icon="heroicons-outline:magnifying-glass" onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? "Scanning…" : "Scan network"}
            </Button>
          </>
        )
      }
    >
      {form ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Field as="select" label="Brand" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} options={CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label }))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} containerClassName="col-span-2" />
            <Field label="Port" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="admin" />
            <Field label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Network (CIDR)" value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="Auto — e.g. 192.168.1.0/24" />
            <Field as="select" label="Brand filter" value={brand} onChange={(e) => setBrand(e.target.value)} options={[{ value: "", label: "Any brand" }, ...CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label }))]} />
          </div>
          {devices.length ? (
            <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-card-border p-2">
              {devices.map((d) => (
                <div key={d.ip + d.port} className="flex items-center justify-between gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{d.name || d.manufacturer || "Recorder"}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{d.ip}:{d.port}</p>
                  </div>
                  <Button variant="secondary" className="!px-2.5 !py-1 !text-xs" onClick={() => choose(d)}>Select</Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-card-border px-4 py-10 text-center text-xs text-muted">
              {scan.isPending ? (
                <span className="inline-flex items-center gap-2"><Icon icon="svg-spinners:180-ring" className="text-base" /> Scanning…</span>
              ) : (
                "Scan the LAN for NVR/DVR recorders."
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
