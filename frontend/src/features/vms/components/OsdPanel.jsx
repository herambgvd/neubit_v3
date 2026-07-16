"use client";

// OsdPanel — live ONVIF OSD / text-overlay editor. Reads the camera's on-screen text
// items (over Media2, served from the persisted value) and lets the operator set the
// overlay text + toggle the timestamp. Devices without Media2 OSD show "not supported".
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";

export default function OsdPanel({ cameraId, cameraName }) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const qc = useQueryClient();

  const osdQ = useQuery({
    queryKey: ["vms-osd", cameraId],
    queryFn: () => vms.cameras.getOsd(cameraId),
    enabled: !!cameraId,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const osds = osdQ.data?.osds || [];
  const plain = osds.find((o) => (o.type || "").toLowerCase().startsWith("plain")) || {};
  const hasDatetime = osds.some((o) => /date|time/i.test(o.type || ""));

  const [text, setText] = useState("");
  const [showDt, setShowDt] = useState(false);
  useEffect(() => {
    if (!osdQ.data) return;
    setText(plain.text || "");
    setShowDt(hasDatetime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osdQ.data]);

  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      const fresh = await vms.cameras.getOsd(cameraId, { refresh: true });
      qc.setQueryData(["vms-osd", cameraId], fresh);
    } catch (e) {
      toast.error(apiError(e, "Could not re-read OSD"));
    } finally {
      setReloading(false);
    }
  };

  const apply = useMutation({
    mutationFn: () => vms.cameras.setOsd(cameraId, { text, show_datetime: showDt }),
    onSuccess: (fresh) => {
      toast.success(`Overlay applied to ${cameraName || "camera"}`);
      if (fresh) qc.setQueryData(["vms-osd", cameraId], fresh);
    },
    onError: (e) => toast.error(apiError(e, "Camera rejected the overlay change")),
  });

  if (osdQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Reading overlay…
      </div>
    );
  }
  if (osdQ.isError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-card-border bg-hover px-3 py-2.5 text-[11px] text-muted">
        <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
        <span>This camera does not expose on-screen text overlays (OSD) over ONVIF.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Overlay text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Lobby North" disabled={!canManage} />
      <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
        <div>
          <p className="text-sm text-foreground">Show date &amp; time</p>
          <p className="text-[11px] text-muted">Burn the timestamp onto the video.</p>
        </div>
        <Toggle checked={showDt} onChange={setShowDt} disabled={!canManage} />
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
