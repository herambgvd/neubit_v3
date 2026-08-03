"use client";

// Dewarp (fisheye) + POS overlay editors. Both persist STORE-ONLY local config on
// the recorder (no ONVIF verb): dewarp is applied client-side by the player for
// fisheye sources; the POS overlay is burned in by the player/exporter where a POS
// text source is wired. Reads gate on vms.camera.read; writes on vms.config.manage.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Input, Select, Toggle } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";

const MOUNTS = [
  { value: "ceiling", label: "Ceiling" },
  { value: "wall", label: "Wall" },
  { value: "desk", label: "Desk / table" },
];
const VIEWS = [
  { value: "original", label: "Original (fisheye)" },
  { value: "panorama", label: "Panorama (180°)" },
  { value: "quad", label: "Quad (4-up)" },
  { value: "dewarp", label: "Single de-warped" },
];
const POSITIONS = [
  { value: "bottom", label: "Bottom" },
  { value: "top", label: "Top" },
];

function ToggleRow({ label, hint, checked, onChange, disabled }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="text-[11px] text-muted">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function DewarpPanel({ cameraId, cameraName }) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["vms-dewarp", cameraId],
    queryFn: () => vms.cameras.dewarp.get(cameraId),
    enabled: !!cameraId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [enabled, setEnabled] = useState(false);
  const [mount, setMount] = useState("ceiling");
  const [view, setView] = useState("panorama");
  useEffect(() => {
    const d = q.data?.dewarp;
    if (!d) return;
    setEnabled(!!d.enabled);
    if (d.mount) setMount(d.mount);
    if (d.view) setView(d.view);
  }, [q.data]);

  const apply = useMutation({
    mutationFn: () => vms.cameras.dewarp.put(cameraId, { enabled, mount, view }),
    onSuccess: () => {
      // Share the cache key the live player reads so the change is visible there
      // immediately (the player caches this store-only config with staleTime:∞).
      queryClient.invalidateQueries({ queryKey: ["vms-dewarp", cameraId] });
      toast.success(`De-warp saved for ${cameraName || "camera"}`);
    },
    onError: (e) => toast.error(apiError(e, "Could not save de-warp")),
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ToggleRow
        label="Enable de-warp"
        hint="For fisheye / panoramic lenses — the player un-distorts this source."
        checked={enabled}
        onChange={setEnabled}
        disabled={!canManage}
      />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Mount" options={MOUNTS} value={mount} onChange={(e) => setMount(e.target.value)} disabled={!canManage || !enabled} />
        <Select label="View" options={VIEWS} value={view} onChange={(e) => setView(e.target.value)} disabled={!canManage || !enabled} />
      </div>
      <p className="text-[11px] text-muted/70">
        Stored on the recorder and applied by the player — no camera round-trip.
      </p>
      {canManage && (
        <div className="flex justify-end">
          <Button variant="primary" icon="heroicons-outline:check" onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PosOverlayPanel({ cameraId, cameraName }) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");

  const q = useQuery({
    queryKey: ["vms-pos-overlay", cameraId],
    queryFn: () => vms.cameras.posOverlay.get(cameraId),
    enabled: !!cameraId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState("");
  const [position, setPosition] = useState("bottom");
  useEffect(() => {
    const p = q.data?.pos_overlay;
    if (!p) return;
    setEnabled(!!p.enabled);
    if (p.source) setSource(p.source);
    if (p.position) setPosition(p.position);
  }, [q.data]);

  const apply = useMutation({
    mutationFn: () => vms.cameras.posOverlay.put(cameraId, { enabled, source: source.trim(), position }),
    onSuccess: () => toast.success(`POS overlay saved for ${cameraName || "camera"}`),
    onError: (e) => toast.error(apiError(e, "Could not save POS overlay")),
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ToggleRow
        label="Enable POS overlay"
        hint="Burn point-of-sale transaction text onto this camera's video."
        checked={enabled}
        onChange={setEnabled}
        disabled={!canManage}
      />
      <Input
        label="Transaction source"
        placeholder="POS terminal id or host:port"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        disabled={!canManage || !enabled}
      />
      <Select label="Position" options={POSITIONS} value={position} onChange={(e) => setPosition(e.target.value)} disabled={!canManage || !enabled} />
      <p className="text-[11px] text-muted/70">
        Stored on the recorder; the player/exporter overlays it where a POS feed is wired.
      </p>
      {canManage && (
        <div className="flex justify-end">
          <Button variant="primary" icon="heroicons-outline:check" onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
