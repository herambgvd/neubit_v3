"use client";

// Onboard step 2 — DDS server onboarding form. Ported from neubit_v2's
// onboard-instance-modal.jsx: name + site + base URL + auth tabs (basic/jwt) +
// username/secret + reconciler cron, with URL normalization + validation.
// Rethemed to v3 tokens; uses shared kit Modal/Button + common Field + Select.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { gates } from "../api";
import { AUTH_METHODS } from "../constants";

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

export default function OnboardInstanceModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({
    name: "",
    site_id: "",
    base_url: "",
    auth_type: "basic",
    username: "",
    secret: "",
    reconciler_cron: "0 3 * * *",
  });
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const sitesQ = useQuery({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 200 }),
  });
  const sites = asItems(sitesQ.data);

  const m = useMutation({
    mutationFn: () =>
      gates.instances.create({ ...form, base_url: normalizeBaseUrl(form.base_url) }),
    onSuccess: () => {
      toast.success("DDS server onboarded");
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Onboard failed")),
  });

  const validate = () => {
    const next = {};
    const url = normalizeBaseUrl(form.base_url);
    if (!form.name.trim() || form.name.trim().length < 2) next.name = "Required (min 2 chars)";
    if (!url) next.base_url = "Required";
    else if (!isValidHttpUrl(url)) next.base_url = "Must start with http:// or https://";
    if (!form.username.trim()) next.username = "Required";
    if (!form.secret) next.secret = "Required";
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
      title="Onboard DDS Server"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ac-onboard-form" variant="success" disabled={m.isPending}>
            {m.isPending ? "Onboarding…" : "Onboard"}
          </Button>
        </>
      }
    >
      <form id="ac-onboard-form" noValidate onSubmit={submit} className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-card-border bg-hover p-3">
          <Icon icon="heroicons-outline:server" className="mt-0.5 text-base text-muted" />
          <p className="text-xs text-muted">
            A DDS (Amadeus8) access-control server belongs to one site. Multiple servers may be
            onboarded for the same site. Ensure the server is reachable from this network and has an
            API-enabled user.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Instance Name"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. HQ-DDS-1"
            error={errors.name}
          />
          <Field
            as="select"
            label="Site"
            value={form.site_id}
            onChange={(e) => set({ site_id: e.target.value })}
            options={[{ value: "", label: "— Optional —" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
          />
        </div>

        <Field
          label="Base URL"
          value={form.base_url}
          onChange={(e) => set({ base_url: e.target.value })}
          placeholder="http://dds.local:10695"
          error={errors.base_url}
        />

        <div>
          <div className="mb-3 flex items-center border-b border-card-border">
            {AUTH_METHODS.map((a) => {
              const active = form.auth_type === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => set({ auth_type: a.id })}
                  className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition ${
                    active ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  <Icon icon={a.icon} className="text-sm" />
                  {a.label}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Username"
              value={form.username}
              onChange={(e) => set({ username: e.target.value })}
              placeholder="Admin"
              error={errors.username}
            />
            <Field
              label={form.auth_type === "basic" ? "API Key" : "Password"}
              type={form.auth_type === "basic" ? "text" : "password"}
              value={form.secret}
              onChange={(e) => set({ secret: e.target.value })}
              placeholder={form.auth_type === "basic" ? "00000000-0000-0000-0000-000000000001" : "••••••••"}
              error={errors.secret}
            />
          </div>
        </div>

        <Field
          label="Reconciler cron (optional)"
          value={form.reconciler_cron}
          onChange={(e) => set({ reconciler_cron: e.target.value })}
          placeholder="0 3 * * *"
        />
      </form>
    </Modal>
  );
}
