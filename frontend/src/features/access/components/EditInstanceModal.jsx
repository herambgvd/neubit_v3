"use client";

// Edit an onboarded instance. Ported from neubit_v2's edit-instance-modal.jsx:
// diffs each field vs the original and only PATCHes what changed; secret is
// rotated only when the "Rotate" toggle is on. Rethemed to v3 tokens.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { gates } from "../api";

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.hostname?.endsWith(".")) u.hostname = u.hostname.replace(/\.+$/, "");
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

export default function EditInstanceModal({ instance, onClose, onSuccess }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: instance.name || "",
    site_id: instance.site_id || "",
    base_url: instance.base_url || "",
    auth_type: instance.auth_type || "basic",
    username: instance.username || "",
    secret: "",
    reconciler_cron: instance.reconciler_cron || "",
  });
  const [rotateSecret, setRotateSecret] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const sitesQ = useQuery({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 200 }),
  });
  const sites = asItems(sitesQ.data);

  const m = useMutation({
    mutationFn: () => {
      const body = {};
      const url = normalizeBaseUrl(form.base_url);
      if (form.name !== instance.name) body.name = form.name;
      if (form.site_id !== (instance.site_id || "")) body.site_id = form.site_id || null;
      if (url !== instance.base_url) body.base_url = url;
      if (form.auth_type !== instance.auth_type) body.auth_type = form.auth_type;
      if (form.username !== instance.username) body.username = form.username;
      if (rotateSecret && form.secret) body.secret = form.secret;
      if (form.reconciler_cron !== (instance.reconciler_cron || "")) body.reconciler_cron = form.reconciler_cron;
      return gates.instances.update(instance.id, body);
    },
    onSuccess: () => {
      toast.success("Instance updated");
      qc.invalidateQueries({ queryKey: ["ac-instances"] });
      qc.invalidateQueries({ queryKey: ["ac-instance", instance.id] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const validate = () => {
    const next = {};
    const url = normalizeBaseUrl(form.base_url);
    if (!form.name.trim()) next.name = "Required";
    if (!url || !isValidHttpUrl(url)) next.base_url = "Must start with http:// or https://";
    if (!form.username.trim()) next.username = "Required";
    if (rotateSecret && !form.secret) next.secret = "Required to rotate";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (validate()) m.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit · ${instance.name}`}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ac-edit-form" variant="success" disabled={m.isPending}>
            {m.isPending ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <form id="ac-edit-form" noValidate onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Instance Name"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            error={errors.name}
          />
          <Field
            as="select"
            label="Site"
            value={form.site_id}
            onChange={(e) => set({ site_id: e.target.value })}
            options={[{ value: "", label: "— Unassigned —" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
          />
        </div>

        <Field
          label="Base URL"
          value={form.base_url}
          onChange={(e) => set({ base_url: e.target.value })}
          error={errors.base_url}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field
            as="select"
            label="Auth Type"
            value={form.auth_type}
            onChange={(e) => set({ auth_type: e.target.value })}
            options={[
              { value: "basic", label: "Basic (user + API key)" },
              { value: "jwt", label: "JWT (user + password)" },
            ]}
          />
          <Field
            label="Username"
            value={form.username}
            onChange={(e) => set({ username: e.target.value })}
            error={errors.username}
          />
        </div>

        <div className="rounded-lg border border-card-border bg-hover p-3">
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input type="checkbox" checked={rotateSecret} onChange={(e) => setRotateSecret(e.target.checked)} />
            Rotate {form.auth_type === "basic" ? "API key" : "password"}
          </label>
          {rotateSecret && (
            <div className="mt-3">
              <Field
                label={form.auth_type === "basic" ? "New API Key" : "New Password"}
                type={form.auth_type === "basic" ? "text" : "password"}
                value={form.secret}
                onChange={(e) => set({ secret: e.target.value })}
                error={errors.secret}
              />
            </div>
          )}
        </div>

        <Field
          label="Reconciler cron"
          value={form.reconciler_cron}
          onChange={(e) => set({ reconciler_cron: e.target.value })}
        />
      </form>
    </Modal>
  );
}
