"use client";

// IoPanel — the live ONVIF I/O editor for the camera "I/O" tab. Enumerates the
// device's relay outputs (GET /cameras/{id}/io) and renders each as a toggle that
// pulses the relay (PATCH → SetRelayOutputState); digital inputs are shown read-only
// with their idle state. Self-contained (own fetch + writes), like ImagingPanel.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Toggle } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";

export default function IoPanel({ cameraId, cameraName }) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const qc = useQueryClient();

  // Served from the I/O map persisted on the camera row — no device re-enumerate on
  // every open. Reload forces a live re-read (refresh:true).
  const ioQ = useQuery({
    queryKey: ["vms-io", cameraId],
    queryFn: () => vms.cameras.getIo(cameraId),
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
      const fresh = await vms.cameras.getIo(cameraId, { refresh: true });
      qc.setQueryData(["vms-io", cameraId], fresh);
    } catch (e) {
      toast.error(apiError(e, "Could not re-read I/O from the camera"));
    } finally {
      setReloading(false);
    }
  };

  const relays = ioQ.data?.relay_outputs || [];
  const inputs = ioQ.data?.digital_inputs || [];

  const setRelay = useMutation({
    mutationFn: ({ token, state }) => vms.cameras.setIo(cameraId, { relay_token: token, state }),
    onSuccess: (fresh) => {
      toast.success("Relay updated");
      if (fresh) qc.setQueryData(["vms-io", cameraId], fresh);
    },
    onError: (e) => toast.error(apiError(e, "Could not switch relay")),
  });

  if (ioQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Enumerating I/O ports over ONVIF…
      </div>
    );
  }

  if (ioQ.isError) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] text-amber-500/90">
          <Icon icon="heroicons-outline:exclamation-triangle" className="mt-0.5 shrink-0 text-sm" />
          <span>{apiError(ioQ.error, "The camera did not return I/O ports — it may be offline or expose no digital I/O over ONVIF.")}</span>
        </div>
        <Button variant="secondary" icon="heroicons-outline:arrow-path" onClick={reload} disabled={reloading}>
          Retry
        </Button>
      </div>
    );
  }

  const isActive = (r) => String(r.idle_state || "").toLowerCase() !== "closed";

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-card-border bg-hover px-3 py-2.5 text-[11px] text-muted">
        <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
        <span>Relays and alarm contacts read live from the camera over ONVIF. Toggle a relay to switch it; bind inputs to actions in Workflow.</span>
      </div>

      {/* Relay outputs */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Relay outputs ({relays.length})</p>
        {relays.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-4 py-6 text-center text-xs text-muted">
            No relay outputs on this camera.
          </div>
        ) : (
          <div className="space-y-2">
            {relays.map((r) => (
              <div key={r.token} className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{r.token}</p>
                  <p className="text-[11px] text-muted">
                    Mode {r.mode || "—"} · idle {r.idle_state || "—"}
                  </p>
                </div>
                <Toggle
                  checked={isActive(r)}
                  disabled={!canManage || setRelay.isPending}
                  onChange={(v) => setRelay.mutate({ token: r.token, state: v ? "active" : "inactive" })}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Digital inputs (read-only) */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Digital inputs ({inputs.length})</p>
        {inputs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-4 py-6 text-center text-xs text-muted">
            No digital inputs on this camera.
          </div>
        ) : (
          <div className="space-y-2">
            {inputs.map((i) => (
              <div key={i.token} className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
                <p className="truncate text-sm text-foreground">{i.token}</p>
                <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">idle {i.idle_state || "—"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" icon="heroicons-outline:arrow-path" onClick={reload} disabled={reloading}>
          {reloading ? "Reading…" : "Reload"}
        </Button>
      </div>
    </div>
  );
}
