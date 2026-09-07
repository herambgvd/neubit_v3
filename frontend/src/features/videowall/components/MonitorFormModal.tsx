"use client";

// Add / edit a monitor on a wall. A monitor is one screen: name, position (which
// slot in the wall grid), kind (browser kiosk vs hardware decoder), and its own
// cell layout (1/4/9/16). A decoder monitor also binds a registered decoder +
// output channel (VW-B pushes the camera RTSP to that decoder channel).
import { useEffect, useMemo, useState } from "react";

import { Button, Input, Modal, Select } from "@/components/ui/kit";
import { MONITOR_LAYOUTS, type WallMonitor } from "../wallLayout";
import type { DecoderPublic, MonitorCreate, MonitorKind, MonitorLayout } from "../types";

const KIND_OPTS = [
  { value: "browser", label: "Browser (kiosk screen)" },
  { value: "decoder", label: "Hardware decoder" },
];

const LAYOUT_OPTS = MONITOR_LAYOUTS.map((l) => ({ value: String(l.value), label: l.label }));

/** The edit buffer. Number fields hold the input's raw string until submit
 *  coerces them, so both shapes are allowed here. */
interface MonitorForm {
  name: string;
  position: number | string;
  kind: string;
  layout: number | string;
  decoder_id: string;
  decoder_channel: number | string;
}

export interface MonitorFormModalProps {
  open: boolean;
  /** The monitor being edited, or null/undefined to add one. */
  monitor?: WallMonitor | null;
  /** The tenant's registered decoders (for a `kind: "decoder"` monitor). */
  decoders?: DecoderPublic[];
  /** Slot suggested for a NEW monitor — the count already on the wall. */
  defaultPosition?: number;
  onClose: () => void;
  onSubmit?: (body: MonitorCreate) => void;
  busy?: boolean;
}

export default function MonitorFormModal({
  open,
  monitor,
  decoders = [],
  defaultPosition = 0,
  onClose,
  onSubmit,
  busy,
}: MonitorFormModalProps) {
  const editing = !!monitor;
  const [form, setForm] = useState<MonitorForm | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: monitor?.name || "",
      position: monitor?.position ?? defaultPosition,
      kind: monitor?.kind || "browser",
      layout: monitor?.layout || 1,
      decoder_id: monitor?.decoder_id || "",
      decoder_channel: monitor?.decoder_channel ?? 0,
    });
  }, [open, monitor, defaultPosition]);

  const decoderOpts = useMemo(
    () => [{ value: "", label: "Select decoder…" }, ...decoders.map((d) => ({ value: d.id, label: `${d.name} (${d.brand})` }))],
    [decoders],
  );

  if (!open || !form) return null;
  const set = <K extends keyof MonitorForm>(k: K, v: MonitorForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));
  const isDecoder = form.kind === "decoder";

  const submit = () => {
    const body: MonitorCreate = {
      name: form.name.trim(),
      position: Number(form.position),
      kind: form.kind as MonitorKind,
      layout: Number(form.layout) as MonitorLayout,
      decoder_id: isDecoder ? form.decoder_id || null : null,
      decoder_channel: isDecoder ? Number(form.decoder_channel) : null,
    };
    onSubmit?.(body);
  };

  const valid = form.name.trim() && (!isDecoder || form.decoder_id);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit monitor" : "Add monitor"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Saving…" : editing ? "Save" : "Add monitor"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Screen 1 (top-left)" autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Position"
            type="number"
            min={0}
            value={form.position}
            onChange={(e) => set("position", e.target.value)}
            hint="Slot order in the wall grid (0 = first)"
          />
          <Select label="Cell layout" options={LAYOUT_OPTS} value={String(form.layout)} onChange={(e) => set("layout", e.target.value)} />
        </div>
        <Select label="Kind" options={KIND_OPTS} value={form.kind} onChange={(e) => set("kind", e.target.value)} />

        {isDecoder && (
          <div className="space-y-3 rounded-[9px] border border-[rgba(251,191,36,.3)] bg-[rgba(251,191,36,.06)] p-3">
            <p className="text-[11px] text-nb-warn">
              Decoder monitors push camera streams to a hardware video decoder output (VW-B). The console preview still plays
              live so you can see what&apos;s routed.
            </p>
            <Select
              label="Decoder"
              options={decoderOpts}
              value={form.decoder_id}
              onChange={(e) => set("decoder_id", e.target.value)}
              placeholder="Select decoder…"
            />
            <Input
              label="Output channel"
              type="number"
              min={0}
              value={form.decoder_channel}
              onChange={(e) => set("decoder_channel", e.target.value)}
            />
            {decoders.length === 0 && (
              <p className="text-[11px] text-nb-faint">No decoders registered yet — add one in the Decoders section first.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
