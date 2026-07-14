"use client";

// VMS → Device / fleet management (G7) — the per-camera "Maintenance" tab body.
// Shows the camera's device/firmware info (best-effort over the brand driver) and
// exposes maintenance ops: Reboot, Set NTP, Change password, Backup config
// (download) and Restore config (upload → base64 → POST). Every op is best-effort:
// the backend returns { ok, supported, detail } and we surface that as a toast —
// "applied" / "not supported on this brand" / "failed".
//
// Reads (device-info) gate on vms.camera.read; all writes on vms.config.manage.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import CodecBadge from "./CodecBadge";

// Turn a { ok, supported, detail } op result into a toast. `supported === false`
// means the brand driver has no such op — surface it as an info, not an error.
export function toastOpResult(res, fallbackLabel = "Done") {
  const detail = res?.detail || "";
  if (res?.supported === false) {
    toast.message(`Not supported on this camera`, { description: detail || undefined });
  } else if (res?.ok) {
    toast.success(detail || `${fallbackLabel} applied`);
  } else {
    toast.error(detail || `${fallbackLabel} failed`);
  }
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-card-border/50 py-1.5 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="truncate text-right text-sm font-medium text-foreground">{value || "—"}</span>
    </div>
  );
}

export default function DeviceMaintenance({ cameraId, cameraName, camera }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canManage = can("vms.config.manage");
  const canRead = can("vms.camera.read");

  // Fresh camera row for the codec badge — seeded by the passed-in `camera` so it
  // renders instantly, then re-read after an apply so the badge flips to H.264.
  const cameraQ = useQuery({
    queryKey: ["vms-camera", cameraId],
    queryFn: () => vms.cameras.get(cameraId),
    enabled: canRead,
    initialData: camera,
    staleTime: 15_000,
  });
  const cam = cameraQ.data || camera || {};

  const [ntpServer, setNtpServer] = useState("");
  const [pwUser, setPwUser] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [confirm, setConfirm] = useState(null);
  const restoreInput = useRef(null);

  // ── Device info (firmware / model) ────────────────────────────────────
  const infoQ = useQuery({
    queryKey: ["vms-device-info", cameraId],
    queryFn: () => vms.deviceMgmt.info(cameraId),
    enabled: canRead,
    retry: false,
    staleTime: 30_000,
  });
  const info = infoQ.data || {};

  // Pull the best-known fields out of a brand-dependent shape.
  const infoRows = useMemo(
    () => [
      { label: "Manufacturer", value: info.manufacturer || info.make },
      { label: "Model", value: info.model },
      { label: "Firmware", value: info.firmware || info.firmware_version },
      { label: "Serial", value: info.serial || info.serial_number },
      { label: "Hardware ID", value: info.hardware_id || info.hardware },
      { label: "MAC", value: info.mac || info.mac_address },
    ],
    [info],
  );

  // ── Mutations ─────────────────────────────────────────────────────────
  const reboot = useMutation({
    mutationFn: () => vms.deviceMgmt.reboot(cameraId),
    onSuccess: (res) => toastOpResult(res, "Reboot"),
    onError: (e) => toast.error(apiError(e, "Reboot failed")),
  });

  const ntp = useMutation({
    mutationFn: () => vms.deviceMgmt.ntp(cameraId, ntpServer.trim()),
    onSuccess: (res) => toastOpResult(res, "NTP"),
    onError: (e) => toast.error(apiError(e, "Set NTP failed")),
  });

  const password = useMutation({
    mutationFn: () =>
      vms.deviceMgmt.password(cameraId, { user: pwUser.trim() || undefined, new_password: pwNew }),
    onSuccess: (res) => {
      toastOpResult(res, "Password change");
      if (res?.ok) setPwNew("");
    },
    onError: (e) => toast.error(apiError(e, "Password change failed")),
  });

  const backup = useMutation({
    mutationFn: () => vms.deviceMgmt.configBackup(cameraId),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(cameraName || cameraId).toString().replace(/[^\w.-]+/g, "_")}-config.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Config downloaded");
    },
    onError: (e) => toast.error(apiError(e, "Backup failed")),
  });

  const restore = useMutation({
    mutationFn: (base64) => vms.deviceMgmt.configRestore(cameraId, base64),
    onSuccess: (res) => toastOpResult(res, "Config restore"),
    onError: (e) => toast.error(apiError(e, "Restore failed")),
  });

  // ── Web codec policy — force the sub-stream to H.264 (browser-direct) ──────
  const streamPolicy = useMutation({
    mutationFn: () => vms.cameras.applyStreamPolicy(cameraId),
    onSuccess: (res) => {
      if (res?.already) {
        toast.message("Already H.264", {
          description: res.detail || "The sub-stream is already H.264 — browsers play it directly.",
        });
      } else {
        toastOpResult(res, "Web profile");
      }
      // Refresh so the codec badge reflects the new sub-stream codec.
      cameraQ.refetch();
      qc.invalidateQueries({ queryKey: ["vms-cameras"] });
    },
    onError: (e) => toast.error(apiError(e, "Apply web profile failed")),
  });

  const pending =
    reboot.isPending ||
    ntp.isPending ||
    password.isPending ||
    backup.isPending ||
    restore.isPending ||
    streamPolicy.isPending;

  // Read the picked file → base64 (strip the data: prefix) → POST.
  const onRestoreFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      setConfirm({
        title: "Restore configuration",
        message: `Push "${file.name}" to ${cameraName}? This overwrites the camera's current configuration and may reboot it.`,
        confirmLabel: "Restore",
        onConfirm: () => {
          restore.mutate(base64);
          setConfirm(null);
        },
      });
    };
    reader.onerror = () => toast.error("Could not read the file");
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-5">
      {/* Device info */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Device info</h4>
          <CodecBadge camera={cam} />
        </div>
        <div className="rounded-lg border border-card-border bg-hover/30 px-3 py-2">
          {infoQ.isLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted">
              <Icon icon="svg-spinners:180-ring" className="text-base" /> Querying device…
            </div>
          ) : infoQ.isError ? (
            <p className="py-2 text-xs text-muted">
              Device info unavailable — {apiError(infoQ.error, "the camera did not respond")}.
            </p>
          ) : (
            infoRows.map((r) => <InfoRow key={r.label} label={r.label} value={r.value} />)
          )}
        </div>
      </section>

      {!canManage && (
        <div className="flex items-start gap-2 rounded-lg border border-card-border bg-hover px-3 py-2.5 text-[11px] text-muted">
          <Icon icon="heroicons-outline:lock-closed" className="mt-0.5 shrink-0 text-sm" />
          <span>You have read-only access. Maintenance actions require the config-manage permission.</span>
        </div>
      )}

      {/* Maintenance actions */}
      <section className={canManage ? "" : "pointer-events-none opacity-50"}>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Maintenance</h4>

        <div className="space-y-3">
          {/* Reboot */}
          <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-foreground">Reboot camera</p>
              <p className="text-[11px] text-muted">Power-cycle the device. Live/recording drops briefly.</p>
            </div>
            <Button
              variant="danger"
              icon="heroicons-outline:arrow-path"
              className="!px-2.5 !py-1.5 !text-xs"
              disabled={!canManage || pending}
              onClick={() =>
                setConfirm({
                  title: "Reboot camera",
                  message: `Reboot ${cameraName}? It will be offline for ~30–60s.`,
                  confirmLabel: "Reboot",
                  onConfirm: () => {
                    reboot.mutate();
                    setConfirm(null);
                  },
                })
              }
            >
              Reboot
            </Button>
          </div>

          {/* NTP / time-sync */}
          <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <p className="mb-1.5 text-sm text-foreground">Time sync (NTP)</p>
            <div className="flex items-end gap-2">
              <Field
                containerClassName="flex-1"
                placeholder="pool.ntp.org or 10.0.0.1"
                value={ntpServer}
                onChange={(e) => setNtpServer(e.target.value)}
              />
              <Button
                variant="secondary"
                className="!py-2 !text-xs"
                disabled={!canManage || pending || !ntpServer.trim()}
                onClick={() => ntp.mutate()}
              >
                Set NTP
              </Button>
            </div>
          </div>

          {/* Change password */}
          <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <p className="mb-1.5 text-sm text-foreground">Change device password</p>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="User"
                placeholder="admin (blank = current)"
                value={pwUser}
                onChange={(e) => setPwUser(e.target.value)}
              />
              <Field
                label="New password"
                type="password"
                placeholder="••••••••"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
              />
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                variant="secondary"
                icon="heroicons-outline:key"
                className="!py-1.5 !text-xs"
                disabled={!canManage || pending || !pwNew}
                onClick={() =>
                  setConfirm({
                    title: "Change device password",
                    message: `Change the ${pwUser.trim() || "current"} account password on ${cameraName}? Make sure the stored ONVIF credentials are updated to match, or the camera may go unreachable.`,
                    confirmLabel: "Change password",
                    danger: false,
                    onConfirm: () => {
                      password.mutate();
                      setConfirm(null);
                    },
                  })
                }
              >
                Change
              </Button>
            </div>
          </div>

          {/* Config backup / restore */}
          <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <p className="mb-1.5 text-sm text-foreground">Configuration</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon="heroicons-outline:arrow-down-tray"
                className="!py-1.5 !text-xs"
                disabled={!canManage || pending}
                onClick={() => backup.mutate()}
              >
                {backup.isPending ? "Backing up…" : "Backup config"}
              </Button>
              <Button
                variant="secondary"
                icon="heroicons-outline:arrow-up-tray"
                className="!py-1.5 !text-xs"
                disabled={!canManage || pending}
                onClick={() => restoreInput.current?.click()}
              >
                {restore.isPending ? "Restoring…" : "Restore config"}
              </Button>
              <input
                ref={restoreInput}
                type="file"
                className="hidden"
                onChange={(e) => {
                  onRestoreFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              Backup downloads the device config blob. Restore uploads it back (base64) — brand-dependent.
            </p>
          </div>

          {/* Web streaming codec policy — force the sub-stream to H.264 */}
          <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-foreground">Web streaming profile</p>
              <CodecBadge camera={cam} showDash />
            </div>
            <p className="mt-1 mb-2 text-[11px] text-muted">
              Forces the sub-stream to H.264 so browsers play it directly — no transcoding. The main
              stream stays H.265 for recording.
            </p>
            <div className="flex justify-end">
              <Button
                variant="secondary"
                icon="heroicons-outline:bolt"
                className="!py-1.5 !text-xs"
                disabled={!canManage || pending}
                onClick={() => streamPolicy.mutate()}
              >
                {streamPolicy.isPending ? "Applying…" : "Apply web profile (H.264)"}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={pending} />
    </div>
  );
}
