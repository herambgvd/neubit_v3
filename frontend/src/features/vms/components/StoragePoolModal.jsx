"use client";

// Add / edit a storage pool. The visible fields switch on pool_type:
//   local → path
//   nfs/smb → NAS server/share/protocol/credentials/domain
//   s3 → endpoint/bucket/region/access+secret keys/use_ssl
// Credentials (nas_password, s3_secret_key) are write-only — sent only when the
// operator types a value, left blank on edit to keep the stored secret.
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { POOL_TYPES } from "../constants";

const GB = 1024 ** 3;

// Bytes → GB string for the form; "" when unlimited.
const bytesToGb = (b) => (b ? String(Math.round((b / GB) * 100) / 100) : "");
const gbToBytes = (gb) => {
  const n = Number(gb);
  return gb === "" || Number.isNaN(n) || n <= 0 ? null : Math.round(n * GB);
};

function hydrate(pool) {
  return {
    name: pool?.name || "",
    pool_type: pool?.pool_type || "local",
    path: pool?.path || "",
    priority: pool?.priority ?? 0,
    max_size_gb: bytesToGb(pool?.max_size_bytes),
    is_default: pool?.is_default ?? false,
    is_active: pool?.is_active ?? true,
    // NAS
    nas_server: pool?.nas_server || "",
    nas_share: pool?.nas_share || "",
    nas_protocol: pool?.nas_protocol || "nfs",
    nas_username: pool?.nas_username || "",
    nas_password: "",
    nas_domain: pool?.nas_domain || "",
    // S3
    s3_endpoint: pool?.s3_endpoint || "",
    s3_bucket: pool?.s3_bucket || "",
    s3_region: pool?.s3_region || "us-east-1",
    s3_access_key: pool?.s3_access_key || "",
    s3_secret_key: "",
    s3_use_ssl: pool?.s3_use_ssl ?? true,
  };
}

export default function StoragePoolModal({ pool, onClose, onSuccess }) {
  const isEdit = !!pool;
  const qc = useQueryClient();
  const [form, setForm] = useState(() => hydrate(pool));
  const [errors, setErrors] = useState({});
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const isNas = form.pool_type === "nfs" || form.pool_type === "smb";
  const isS3 = form.pool_type === "s3";
  const isLocal = form.pool_type === "local";

  const typeOptions = useMemo(
    () => POOL_TYPES.map((t) => ({ value: t.value, label: t.label })),
    [],
  );

  const buildBody = () => {
    const body = {
      name: form.name.trim(),
      pool_type: form.pool_type,
      path: form.path || null,
      priority: Number(form.priority) || 0,
      max_size_bytes: gbToBytes(form.max_size_gb),
      is_default: !!form.is_default,
      is_active: !!form.is_active,
    };
    if (isNas) {
      body.nas_server = form.nas_server || null;
      body.nas_share = form.nas_share || null;
      body.nas_protocol = form.nas_protocol;
      body.nas_username = form.nas_username || null;
      body.nas_domain = form.nas_domain || null;
      if (form.nas_password) body.nas_password = form.nas_password;
    }
    if (isS3) {
      body.s3_endpoint = form.s3_endpoint || null;
      body.s3_bucket = form.s3_bucket || null;
      body.s3_region = form.s3_region || null;
      body.s3_access_key = form.s3_access_key || null;
      body.s3_use_ssl = !!form.s3_use_ssl;
      if (form.s3_secret_key) body.s3_secret_key = form.s3_secret_key;
    }
    return body;
  };

  const save = useMutation({
    mutationFn: () => (isEdit ? vms.storage.pools.update(pool.id, buildBody()) : vms.storage.pools.create(buildBody())),
    onSuccess: () => {
      toast.success(isEdit ? "Pool updated" : "Pool created");
      qc.invalidateQueries({ queryKey: ["vms-storage-pools"] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const submit = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = "Required";
    if (isLocal && !form.path.trim()) errs.path = "Path required";
    if (isNas && !form.nas_server.trim()) errs.nas_server = "Server required";
    if (isS3 && !form.s3_bucket.trim()) errs.s3_bucket = "Bucket required";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={isEdit ? `Edit pool — ${pool.name}` : "New storage pool"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create pool"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Name"
            required
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Primary — hot"
            error={errors.name}
          />
          <Field
            as="select"
            label="Type"
            value={form.pool_type}
            onChange={(e) => set({ pool_type: e.target.value })}
            options={typeOptions}
          />
        </div>

        {isLocal && (
          <Field
            label="Path"
            required
            value={form.path}
            onChange={(e) => set({ path: e.target.value })}
            placeholder="/data/recordings"
            error={errors.path}
          />
        )}

        {isNas && (
          <div className="space-y-3 rounded-lg border border-card-border bg-hover/40 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Server / IP" required value={form.nas_server} onChange={(e) => set({ nas_server: e.target.value })} placeholder="192.168.1.50" error={errors.nas_server} />
              <Field label="Share / Export" value={form.nas_share} onChange={(e) => set({ nas_share: e.target.value })} placeholder="recordings" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                as="select"
                label="Protocol"
                value={form.nas_protocol}
                onChange={(e) => set({ nas_protocol: e.target.value })}
                options={[{ value: "nfs", label: "NFS" }, { value: "smb", label: "SMB / CIFS" }]}
              />
              <Field label="Domain / Workgroup" value={form.nas_domain} onChange={(e) => set({ nas_domain: e.target.value })} placeholder="WORKGROUP" />
            </div>
            {form.nas_protocol === "smb" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Username" value={form.nas_username} onChange={(e) => set({ nas_username: e.target.value })} placeholder="admin" />
                <Field
                  label="Password"
                  type="password"
                  value={form.nas_password}
                  onChange={(e) => set({ nas_password: e.target.value })}
                  placeholder={isEdit ? "•••••• (unchanged)" : "••••••••"}
                  hint={isEdit ? "Leave blank to keep stored." : undefined}
                />
              </div>
            )}
            <Field label="Mount path" value={form.path} onChange={(e) => set({ path: e.target.value })} placeholder="/mnt/nas-recordings (optional)" />
          </div>
        )}

        {isS3 && (
          <div className="space-y-3 rounded-lg border border-card-border bg-hover/40 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Endpoint" value={form.s3_endpoint} onChange={(e) => set({ s3_endpoint: e.target.value })} placeholder="https://minio:9000 (blank = AWS)" />
              <Field label="Bucket" required value={form.s3_bucket} onChange={(e) => set({ s3_bucket: e.target.value })} placeholder="nvr-cold" error={errors.s3_bucket} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Region" value={form.s3_region} onChange={(e) => set({ s3_region: e.target.value })} placeholder="us-east-1" />
              <Field label="Access key" value={form.s3_access_key} onChange={(e) => set({ s3_access_key: e.target.value })} placeholder={isEdit ? "••••••••" : "AKIA…"} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Secret key"
                type="password"
                value={form.s3_secret_key}
                onChange={(e) => set({ s3_secret_key: e.target.value })}
                placeholder={isEdit ? "•••••• (unchanged)" : "••••••••"}
                hint={isEdit ? "Leave blank to keep stored." : undefined}
              />
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Toggle checked={!!form.s3_use_ssl} onChange={(v) => set({ s3_use_ssl: v })} />
                  Use TLS (https)
                </label>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Priority"
            type="number"
            value={form.priority}
            onChange={(e) => set({ priority: e.target.value })}
            hint="Lower = preferred for new recordings"
          />
          <Field
            label="Max size (GB)"
            type="number"
            value={form.max_size_gb}
            onChange={(e) => set({ max_size_gb: e.target.value })}
            placeholder="Blank = unlimited"
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Toggle checked={!!form.is_default} onChange={(v) => set({ is_default: v })} />
            Set as default pool
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Toggle checked={!!form.is_active} onChange={(v) => set({ is_active: v })} />
            Active
          </label>
        </div>
      </div>
    </Modal>
  );
}
