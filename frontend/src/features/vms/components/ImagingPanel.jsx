"use client";

// ImagingPanel — the live ONVIF imaging editor for the camera "Imaging" tab.
// Reads the camera's current brightness/contrast/saturation/sharpness + WDR +
// day/night (IR-cut) over ONVIF (GET /cameras/{id}/imaging), renders only the
// controls the device actually supports, bounded by the device-reported ranges,
// and pushes changes back (PATCH). Self-contained: it owns its own fetch + apply,
// independent of the camera-row Save.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Toggle } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";

// A labelled slider bounded by the device range, with the live numeric value.
function SliderRow({ label, value, min, max, disabled, onChange }) {
  return (
    <div className="rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
        <span className="font-mono text-xs text-foreground">{value ?? "—"}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value ?? min}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-foreground disabled:opacity-40"
      />
      <div className="mt-0.5 flex justify-between text-[9px] text-muted">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

export default function ImagingPanel({ cameraId, cameraName }) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const qc = useQueryClient();

  // Served from the imaging settings persisted on the camera row — no device re-probe
  // on every open. The Reload button forces a live re-read (refresh:true).
  const imagingQ = useQuery({
    queryKey: ["vms-imaging", cameraId],
    queryFn: () => vms.cameras.getImaging(cameraId),
    enabled: !!cameraId,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      const fresh = await vms.cameras.getImaging(cameraId, { refresh: true });
      qc.setQueryData(["vms-imaging", cameraId], fresh);
    } catch (e) {
      toast.error(apiError(e, "Could not re-read imaging from the camera"));
    } finally {
      setReloading(false);
    }
  };

  const data = imagingQ.data || {};
  const supported = data.supported || {};
  const ranges = data.ranges || {};

  // Local editable copy — seeded from the device read, reset whenever a fresh read lands.
  const [draft, setDraft] = useState({});
  useEffect(() => {
    if (!imagingQ.data) return;
    setDraft({
      brightness: data.brightness,
      contrast: data.contrast,
      color_saturation: data.color_saturation,
      sharpness: data.sharpness,
      wdr_on: (data.wide_dynamic_range?.mode || "OFF").toUpperCase() !== "OFF",
      ir_cut_filter: data.ir_cut_filter || "AUTO",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagingQ.data]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const rng = (key, fallbackMin = 0, fallbackMax = 255) => ({
    min: ranges[key]?.min ?? fallbackMin,
    max: ranges[key]?.max ?? fallbackMax,
  });

  const irModes = useMemo(
    () => ranges.ir_cut_filter_modes || ["ON", "OFF", "AUTO"],
    [ranges.ir_cut_filter_modes],
  );

  const apply = useMutation({
    mutationFn: () => {
      const body = {};
      if (supported.brightness) body.brightness = draft.brightness;
      if (supported.contrast) body.contrast = draft.contrast;
      if (supported.color_saturation) body.color_saturation = draft.color_saturation;
      if (supported.sharpness) body.sharpness = draft.sharpness;
      if (supported.ir_cut_filter && draft.ir_cut_filter) body.ir_cut_filter = draft.ir_cut_filter;
      if (supported.wide_dynamic_range) {
        body.wide_dynamic_range = { mode: draft.wdr_on ? "ON" : "OFF" };
      }
      return vms.cameras.setImaging(cameraId, body);
    },
    onSuccess: (fresh) => {
      toast.success(`Imaging applied to ${cameraName || "camera"}`);
      // The PATCH echoes (and persists) the current device state — seed the cache from it.
      if (fresh) qc.setQueryData(["vms-imaging", cameraId], fresh);
    },
    onError: (e) => toast.error(apiError(e, "Could not apply imaging settings")),
  });

  if (imagingQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Reading imaging settings from the camera…
      </div>
    );
  }

  if (imagingQ.isError) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] text-amber-500/90">
          <Icon icon="heroicons-outline:exclamation-triangle" className="mt-0.5 shrink-0 text-sm" />
          <span>{apiError(imagingQ.error, "The camera did not return imaging settings — it may be offline or not expose the ONVIF imaging service.")}</span>
        </div>
        <Button variant="secondary" icon="heroicons-outline:arrow-path" onClick={reload} disabled={reloading}>
          Retry
        </Button>
      </div>
    );
  }

  const anySupported =
    supported.brightness || supported.contrast || supported.color_saturation ||
    supported.sharpness || supported.wide_dynamic_range || supported.ir_cut_filter;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-card-border bg-hover px-3 py-2.5 text-[11px] text-muted">
        <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
        <span>Read live from the camera over ONVIF. Changes are pushed to the device on Apply.</span>
      </div>

      {!anySupported && (
        <div className="rounded-lg border border-dashed border-card-border px-4 py-8 text-center text-xs text-muted">
          This camera does not expose adjustable imaging controls over ONVIF.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {supported.brightness && (
          <SliderRow
            label="Brightness"
            value={draft.brightness}
            {...rng("brightness")}
            disabled={!canManage}
            onChange={(v) => set({ brightness: v })}
          />
        )}
        {supported.contrast && (
          <SliderRow
            label="Contrast"
            value={draft.contrast}
            {...rng("contrast")}
            disabled={!canManage}
            onChange={(v) => set({ contrast: v })}
          />
        )}
        {supported.color_saturation && (
          <SliderRow
            label="Saturation"
            value={draft.color_saturation}
            {...rng("color_saturation")}
            disabled={!canManage}
            onChange={(v) => set({ color_saturation: v })}
          />
        )}
        {supported.sharpness && (
          <SliderRow
            label="Sharpness"
            value={draft.sharpness}
            {...rng("sharpness")}
            disabled={!canManage}
            onChange={(v) => set({ sharpness: v })}
          />
        )}
      </div>

      {supported.ir_cut_filter && (
        <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
          <div>
            <p className="text-sm text-foreground">Day / Night (IR-cut filter)</p>
            <p className="text-[11px] text-muted">Controls the infra-red cut filter for night vision.</p>
          </div>
          <select
            value={draft.ir_cut_filter || "AUTO"}
            disabled={!canManage}
            onChange={(e) => set({ ir_cut_filter: e.target.value })}
            className="rounded-md border border-card-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-40"
          >
            {irModes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {supported.wide_dynamic_range && (
        <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
          <div>
            <p className="text-sm text-foreground">Wide Dynamic Range (WDR)</p>
            <p className="text-[11px] text-muted">Balances bright and dark areas in high-contrast scenes.</p>
          </div>
          <Toggle checked={!!draft.wdr_on} onChange={(v) => set({ wdr_on: v })} disabled={!canManage} />
        </div>
      )}

      {anySupported && canManage && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" icon="heroicons-outline:arrow-path" onClick={reload} disabled={apply.isPending || reloading}>
            {reloading ? "Reading…" : "Reload"}
          </Button>
          <Button variant="primary" icon="heroicons-outline:check" onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending ? "Applying…" : "Apply to camera"}
          </Button>
        </div>
      )}
    </div>
  );
}
