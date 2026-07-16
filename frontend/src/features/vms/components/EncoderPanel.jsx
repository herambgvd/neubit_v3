"use client";

// EncoderPanel — live ONVIF video-encoder editor (resolution / fps / bitrate / GOP)
// for a stream role (main/sub). Reads over ONVIF (served from the persisted value),
// bounds the inputs by the device-reported options, and pushes changes back. Many
// NVR channels reject encoder writes — that surfaces as a toast, not a crash.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";

export default function EncoderPanel({ cameraId, cameraName }) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const qc = useQueryClient();

  const encQ = useQuery({
    queryKey: ["vms-encoder", cameraId],
    queryFn: () => vms.cameras.getEncoder(cameraId),
    enabled: !!cameraId,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const data = encQ.data || {};
  const options = data.options || {};

  const [draft, setDraft] = useState({});
  useEffect(() => {
    if (!encQ.data) return;
    setDraft({
      resolution: data.resolution || "",
      fps: data.fps ?? "",
      bitrate: data.bitrate ?? "",
      gov_length: data.gov_length ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encQ.data]);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Resolution dropdown options — device list + the current value if it's not in it.
  const resolutionOptions = (() => {
    const list = options.resolutions || [];
    const cur = draft.resolution;
    const all = cur && !list.includes(cur) ? [cur, ...list] : list;
    return all.map((r) => ({ value: r, label: r }));
  })();

  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      const fresh = await vms.cameras.getEncoder(cameraId, { refresh: true });
      qc.setQueryData(["vms-encoder", cameraId], fresh);
    } catch (e) {
      toast.error(apiError(e, "Could not re-read encoder settings"));
    } finally {
      setReloading(false);
    }
  };

  const apply = useMutation({
    mutationFn: () =>
      vms.cameras.setEncoder(cameraId, {
        role: data.role || "main",
        resolution: draft.resolution || undefined,
        fps: draft.fps === "" ? undefined : Number(draft.fps),
        bitrate: draft.bitrate === "" ? undefined : Number(draft.bitrate),
        gov_length: draft.gov_length === "" ? undefined : Number(draft.gov_length),
      }),
    onSuccess: (fresh) => {
      toast.success(`Encoder applied to ${cameraName || "camera"}`);
      if (fresh) qc.setQueryData(["vms-encoder", cameraId], fresh);
    },
    onError: (e) => toast.error(apiError(e, "Camera rejected the encoder change")),
  });

  if (encQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Reading encoder…
      </div>
    );
  }
  if (encQ.isError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] text-amber-500/90">
        <Icon icon="heroicons-outline:exclamation-triangle" className="mt-0.5 shrink-0 text-sm" />
        <span>{apiError(encQ.error, "Encoder settings unavailable — the device may not expose an editable encoder.")}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted">
        {data.codec || "—"} · {data.role || "main"} stream. Changes are pushed to the camera on Apply.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {resolutionOptions.length ? (
          <Field
            label="Resolution"
            as="select"
            value={draft.resolution || ""}
            onChange={(e) => set({ resolution: e.target.value })}
            options={resolutionOptions}
            disabled={!canManage}
          />
        ) : (
          <Field
            label="Resolution"
            value={draft.resolution || ""}
            onChange={(e) => set({ resolution: e.target.value })}
            placeholder="1920x1080"
            disabled={!canManage}
          />
        )}
        <Field
          label="Frame rate (fps)"
          type="number"
          value={draft.fps ?? ""}
          onChange={(e) => set({ fps: e.target.value })}
          hint={options.fps ? `Allowed: ${options.fps.min}–${options.fps.max}` : undefined}
          disabled={!canManage}
        />
        <Field
          label="Bitrate (kbps)"
          type="number"
          value={draft.bitrate ?? ""}
          onChange={(e) => set({ bitrate: e.target.value })}
          disabled={!canManage}
        />
        <Field
          label="GOP / keyframe interval"
          type="number"
          value={draft.gov_length ?? ""}
          onChange={(e) => set({ gov_length: e.target.value })}
          disabled={!canManage}
        />
      </div>
      {canManage && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" icon="heroicons-outline:arrow-path" onClick={reload} disabled={reloading || apply.isPending}>
            {reloading ? "Reading…" : "Reload"}
          </Button>
          <Button variant="primary" icon="heroicons-outline:check" onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending ? "Applying…" : "Apply"}
          </Button>
        </div>
      )}
    </div>
  );
}
