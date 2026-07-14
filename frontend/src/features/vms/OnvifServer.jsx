"use client";

// VMS → ONVIF Server (P6-C). The interop screen: expose OUR cameras to a 3rd-party
// VMS (Milestone / Genetec / etc.) over ONVIF. Per-tenant enable toggle, exposed
// cameras (all or a subset), a service account (write-only password), and the
// advertised device identity (name / host / http+rtsp ports). Shows the connection
// hint (device_service URL + creds) a 3rd-party VMS uses to pull the estate.
//
// GET/PUT /api/v1/vms/onvif-server/config → the vision service. service_password is
// write-only. Gate: vms.config.manage.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Input, PageHeader, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { vms } from "./api";

const PLACEHOLDER = "•••••••• (unchanged)";

export default function OnvifServerPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can("vms.config.manage");

  const cfgQ = useQuery({
    queryKey: ["vms-onvif-server-config"],
    queryFn: () => vms.onvifServer.getConfig(),
  });
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "onvif-server-picker"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  // Local editable form. `allCameras` = the "*" wildcard; else a set of ids.
  const [form, setForm] = useState(null);
  const [allCameras, setAllCameras] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [password, setPassword] = useState(""); // write-only; "" = keep existing

  useEffect(() => {
    const c = cfgQ.data;
    if (!c) return;
    setForm({
      enabled: c.enabled,
      service_username: c.service_username || "",
      device_name: c.device_name || "",
      advertised_host: c.advertised_host || "",
      advertised_http_port: c.advertised_http_port || 80,
      advertised_rtsp_port: c.advertised_rtsp_port || 554,
      password_set: c.password_set,
    });
    const exposed = c.exposed_camera_ids || [];
    const isAll = exposed.length === 1 && exposed[0] === "*";
    setAllCameras(isAll || exposed.length === 0);
    setSelectedIds(new Set(isAll ? [] : exposed));
    setPassword("");
  }, [cfgQ.data]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const toggleCamera = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        enabled: form.enabled,
        exposed_camera_ids: allCameras ? ["*"] : Array.from(selectedIds),
        service_username: form.service_username || undefined,
        device_name: form.device_name || undefined,
        advertised_host: form.advertised_host || null,
        advertised_http_port: form.advertised_http_port ? Number(form.advertised_http_port) : null,
        advertised_rtsp_port: form.advertised_rtsp_port ? Number(form.advertised_rtsp_port) : null,
      };
      // Only send the password if the operator typed a new one (write-only).
      if (password) body.service_password = password;
      return vms.onvifServer.setConfig(body);
    },
    onSuccess: () => {
      toast.success("ONVIF server config saved");
      setPassword("");
      qc.invalidateQueries({ queryKey: ["vms-onvif-server-config"] });
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  if (cfgQ.isLoading || !form) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading ONVIF server config…
      </div>
    );
  }
  if (cfgQ.isError) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
        {apiError(cfgQ.error, "Failed to load config")}
      </div>
    );
  }

  const host = form.advertised_host || (typeof window !== "undefined" ? window.location.hostname : "<host>");
  const httpPort = form.advertised_http_port || 80;
  const deviceUrl =
    httpPort === 80
      ? `http://${host}/onvif/device_service`
      : `http://${host}:${httpPort}/onvif/device_service`;

  return (
    <div className="pb-8">
      <PageHeader
        title="External Access"
        subtitle="Expose your cameras to external systems (Milestone, Genetec, a city command center, …) over ONVIF Profile S. This node acts as an ONVIF device other VMS can discover and pull."
        actions={
          canManage && (
            <Button variant="primary" icon="heroicons-outline:check" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          )
        }
      />

      {/* Status banner */}
      <div
        className={`mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 ${
          form.enabled ? "border-emerald-500/25 bg-emerald-500/10" : "border-card-border bg-card"
        }`}
      >
        <Icon
          icon={form.enabled ? "heroicons-solid:signal" : "heroicons-outline:signal-slash"}
          className={`text-xl ${form.enabled ? "text-emerald-500" : "text-muted"}`}
        />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            ONVIF server is {form.enabled ? "enabled" : "disabled"}
          </p>
          <p className="text-xs text-muted">
            {form.enabled
              ? "A third-party VMS can authenticate and enumerate the exposed cameras."
              : "Enable to let a third-party VMS discover and pull your cameras."}
          </p>
        </div>
        <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={!canManage} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left column — identity + service creds */}
        <div className="space-y-4">
          <Section title="Device identity" desc="How this node advertises itself to the third-party VMS.">
            <Input
              label="Device name"
              value={form.device_name}
              onChange={(e) => set({ device_name: e.target.value })}
              disabled={!canManage}
              placeholder="Neubit VMS"
            />
            <Input
              label="Advertised host"
              value={form.advertised_host}
              onChange={(e) => set({ advertised_host: e.target.value })}
              disabled={!canManage}
              placeholder="vms.example.com (blank = request host)"
              hint="The hostname/IP the other VMS should connect to. Leave blank to use the request host."
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="HTTP port"
                type="number"
                value={form.advertised_http_port}
                onChange={(e) => set({ advertised_http_port: e.target.value })}
                disabled={!canManage}
              />
              <Input
                label="RTSP port"
                type="number"
                value={form.advertised_rtsp_port}
                onChange={(e) => set({ advertised_rtsp_port: e.target.value })}
                disabled={!canManage}
              />
            </div>
          </Section>

          <Section title="Service account" desc="The third-party VMS authenticates with these credentials (WS-Security UsernameToken).">
            <Input
              label="Service username"
              value={form.service_username}
              onChange={(e) => set({ service_username: e.target.value })}
              disabled={!canManage}
              placeholder="onvif-service"
              autoComplete="off"
            />
            <Input
              label="Service password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!canManage}
              placeholder={form.password_set ? PLACEHOLDER : "Set a password"}
              autoComplete="new-password"
              hint={form.password_set ? "A password is set. Type a new one to change it." : "No password set yet."}
            />
          </Section>
        </div>

        {/* Right column — exposed cameras */}
        <div className="space-y-4">
          <Section
            title="Exposed cameras"
            desc="Which cameras the third-party VMS can enumerate and pull."
          >
            <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
              <div>
                <span className="text-sm text-foreground">Expose all cameras</span>
                <p className="text-xs text-muted">Every enabled camera in this tenant.</p>
              </div>
              <Toggle checked={allCameras} onChange={setAllCameras} disabled={!canManage} />
            </label>

            {!allCameras && (
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-card-border p-2">
                {cameras.length === 0 ? (
                  <p className="px-2 py-4 text-center text-sm text-muted">No cameras onboarded.</p>
                ) : (
                  cameras.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleCamera(c.id)}
                        disabled={!canManage}
                        className="h-4 w-4 accent-foreground"
                      />
                      <span className="flex-1 truncate text-sm text-foreground">{c.name}</span>
                      <span className="text-xs text-muted">{c.brand || c.ip_address || ""}</span>
                    </label>
                  ))
                )}
              </div>
            )}
            {!allCameras && (
              <p className="text-xs text-muted">{selectedIds.size} camera(s) selected.</p>
            )}
          </Section>
        </div>
      </div>

      {/* Connection hint — the enterprise interop card */}
      <Section
        title="Third-party VMS connection"
        desc="Point Milestone / Genetec / any ONVIF-capable VMS at this node using the details below."
        className="mt-4"
      >
        <div className="space-y-3">
          <HintRow label="Device service URL" value={deviceUrl} copyable />
          <HintRow label="Username" value={form.service_username || "—"} copyable={!!form.service_username} />
          <HintRow label="Password" value={form.password_set ? "•••••••• (as configured)" : "not set"} />
          <HintRow label="ONVIF profile" value="Profile S (live streaming)" />
          <HintRow label="RTSP port" value={String(form.advertised_rtsp_port || 554)} />
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 text-sm shrink-0" />
          <span>
            The third-party VMS adds this as an ONVIF device using the URL + service credentials. Only the exposed
            cameras above are enumerated. Ensure the advertised host/ports are reachable from that VMS.
          </span>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, desc, children, className = "" }) {
  return (
    <div className={`rounded-xl border border-card-border bg-card p-4 ${className}`}>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {desc && <p className="mb-3 mt-0.5 text-xs text-muted">{desc}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function HintRow({ label, value, copyable }) {
  const copy = () => {
    navigator.clipboard?.writeText(value);
    toast.success("Copied");
  };
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted">{label}</span>
      <code className="flex-1 truncate rounded-md border border-card-border bg-hover/40 px-2.5 py-1.5 text-xs text-foreground">
        {value}
      </code>
      {copyable && (
        <button className="text-muted transition hover:text-foreground" title="Copy" onClick={copy}>
          <Icon icon="heroicons-outline:clipboard-document" className="text-base" />
        </button>
      )}
    </div>
  );
}
