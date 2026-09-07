"use client";

// Register / edit a hardware video decoder (VW-B). Brand (Hikvision / Dahua-
// CP-Plus), host, port, credentials (password WRITE-ONLY — never returned, shows
// "•••• (unchanged)" on edit), and channel count. The password is only sent when
// the operator types a new one, matching the camera/NVR creds-at-rest pattern.
//
// NOTE: the decoder backend (VW-B) may not be live yet — the parent gates this
// modal and surfaces a clear "decoder API not available" message on 404.
import { useEffect, useState } from "react";

import { Button, Input, Modal, Select, Toggle } from "@/components/ui/kit";
import { DECODER_BRANDS } from "../wallLayout";
import type { DecoderBrand, DecoderCreate, DecoderPublic } from "../types";

const PLACEHOLDER = "•••••••• (unchanged)";
const BRAND_OPTS = DECODER_BRANDS.map((b) => ({ value: b.value, label: b.label }));

/** The edit buffer. Number fields hold the input's raw string until submit
 *  coerces them, so both shapes are allowed here. */
interface DecoderForm {
  name: string;
  brand: string;
  host: string;
  port: number | string;
  username: string;
  /** Never prefilled — write-only, sent only when the operator types one. */
  password: string;
  channel_count: number | string;
  is_enabled: boolean;
}

export interface DecoderFormModalProps {
  open: boolean;
  /** The decoder being edited, or null/undefined to register one. */
  decoder?: DecoderPublic | null;
  onClose: () => void;
  onSubmit?: (body: DecoderCreate) => void;
  busy?: boolean;
}

export default function DecoderFormModal({
  open,
  decoder,
  onClose,
  onSubmit,
  busy,
}: DecoderFormModalProps) {
  const editing = !!decoder;
  const [form, setForm] = useState<DecoderForm | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: decoder?.name || "",
      brand: decoder?.brand || "hikvision",
      host: decoder?.host || "",
      port: decoder?.port ?? 80,
      username: decoder?.username || "admin",
      password: "", // never prefilled — write-only
      channel_count: decoder?.channel_count ?? 4,
      is_enabled: decoder?.is_enabled ?? true,
    });
  }, [open, decoder]);

  if (!open || !form) return null;
  const set = <K extends keyof DecoderForm>(k: K, v: DecoderForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const submit = () => {
    const body: DecoderCreate = {
      name: form.name.trim(),
      brand: form.brand as DecoderBrand,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      channel_count: Number(form.channel_count),
      is_enabled: form.is_enabled,
    };
    // Only send password when the operator typed one (create OR rotate).
    if (form.password) body.password = form.password;
    onSubmit?.(body);
  };

  const valid = form.name.trim() && form.host.trim() && (editing || form.password);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit decoder" : "Register decoder"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Saving…" : editing ? "Save" : "Register"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Wall decoder A" autoFocus />
        <Select label="Brand" options={BRAND_OPTS} value={form.brand} onChange={(e) => set("brand", e.target.value)} />
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Input label="Host / IP" value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="192.168.1.50" />
          <Input label="Port" type="number" min={1} value={form.port} onChange={(e) => set("port", e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Username" value={form.username} onChange={(e) => set("username", e.target.value)} />
          <Input
            label="Password"
            type="password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder={editing ? PLACEHOLDER : "Required"}
          />
        </div>
        <Input
          label="Channel count"
          type="number"
          min={1}
          value={form.channel_count}
          onChange={(e) => set("channel_count", e.target.value)}
          hint="Number of decoder output channels"
        />
        <label className="flex items-center justify-between rounded-[9px] border border-nb-line px-3 py-2">
          <span className="text-sm text-nb-ink">Enabled</span>
          <Toggle checked={form.is_enabled} onChange={(v) => set("is_enabled", v)} label="Decoder enabled" />
        </label>
      </div>
    </Modal>
  );
}
