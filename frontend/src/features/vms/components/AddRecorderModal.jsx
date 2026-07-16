"use client";

// Add / edit a MediaNode (recorder) — a standalone recorder machine (its own
// MediaMTX + storage) that cameras are pinned to. Manual path only. On save →
// POST /vms/media-nodes (or PATCH when editing). If the box is unreachable at
// create time the backend still saves it and returns a `warning` — surfaced as a
// warning toast by the caller. Mirrors AddNvrModal.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";

export default function AddRecorderModal({ node, onClose, onSuccess }) {
  const editing = !!node;
  const [form, setForm] = useState(
    editing
      ? {
          name: node.name || "",
          api_url: node.api_url || "",
          hls_base: node.hls_base || "",
          webrtc_base: node.webrtc_base || "",
          rtsp_base: node.rtsp_base || "",
          label: node.label || "",
          capacity_channels: node.capacity_channels ?? "",
        }
      : { name: "", api_url: "", hls_base: "", webrtc_base: "", rtsp_base: "", label: "", capacity_channels: "" },
  );
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        api_url: form.api_url.trim(),
        hls_base: form.hls_base.trim() || undefined,
        webrtc_base: form.webrtc_base.trim() || undefined,
        rtsp_base: form.rtsp_base.trim() || undefined,
        label: form.label.trim() || undefined,
        capacity_channels:
          form.capacity_channels === "" ? undefined : Number(form.capacity_channels) || undefined,
      };
      return editing ? vms.mediaNodes.update(node.id, body) : vms.mediaNodes.create(body);
    },
    onSuccess: (res) => {
      // The backend may save an unreachable node and echo a `warning`.
      if (res?.warning) toast.warning(res.warning);
      else toast.success(editing ? "Recorder updated" : "Recorder added");
      onSuccess?.(res);
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const submit = () => {
    const errs = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = "Required (min 2 chars)";
    if (!form.api_url.trim()) errs.api_url = "Required";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit recorder — ${node.name}` : "Add recorder"}
      wide
      footer={
        <>
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant={editing ? "primary" : "success"} onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Add recorder"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Recorder name"
            required
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Recorder-Node-01"
            error={errors.name}
          />
          <Field
            label="Location / label"
            value={form.label}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="e.g. Server room B"
          />
        </div>

        <Field
          label="API URL"
          required
          value={form.api_url}
          onChange={(e) => set({ api_url: e.target.value })}
          placeholder="http://10.0.0.20:9997"
          error={errors.api_url}
          hint="The recorder's control API endpoint. Saved even if unreachable now."
        />

        <div className="grid grid-cols-3 gap-3">
          <Field
            label="HLS base"
            value={form.hls_base}
            onChange={(e) => set({ hls_base: e.target.value })}
            placeholder="(optional)"
          />
          <Field
            label="WebRTC base"
            value={form.webrtc_base}
            onChange={(e) => set({ webrtc_base: e.target.value })}
            placeholder="(optional)"
          />
          <Field
            label="RTSP base"
            value={form.rtsp_base}
            onChange={(e) => set({ rtsp_base: e.target.value })}
            placeholder="(optional)"
          />
        </div>

        <Field
          label="Capacity (channels)"
          type="number"
          value={form.capacity_channels}
          onChange={(e) => set({ capacity_channels: e.target.value })}
          placeholder="e.g. 64"
          hint="Max cameras this recorder can host. Blank = unlimited / unset."
        />
      </div>
    </Modal>
  );
}
