"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Map as MapIcon, Palette, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";

const inputCls =
  "h-11 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 hover:border-white/20";

export default function PlatformSettingsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-white">Platform</h1>
        <p className="mt-1 text-sm text-slate-400">
          Platform-wide defaults every tenant inherits. Individual tenants can override these in their own settings.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsCard />
        <BrandingCard />
        <MapsCard />
      </div>
    </div>
  );
}

function Card({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="animate-fade-in rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-cyan-300">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, description, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <div>
        <div className="text-sm font-medium text-slate-200">{label}</div>
        {description && <div className="text-xs text-slate-500">{description}</div>}
      </div>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-cyan-400" />
    </label>
  );
}

function SaveButton({ pending }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60"
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      Save
    </button>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-lg bg-white/[0.04]" />
      ))}
    </div>
  );
}

function SettingsCard() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    announcement: "",
    support_email: "",
    allow_avatar_uploads: false,
    allow_signups: false,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["platform", "settings"],
    queryFn: () => adminApi.getPlatformSettings(),
  });

  useEffect(() => {
    if (data) {
      // GET /admin/platform/settings returns { catalog, values } — read from values.
      const v = data?.values ?? data;
      setForm({
        announcement: v.announcement ?? "",
        support_email: v.support_email ?? "",
        allow_avatar_uploads: !!v.allow_avatar_uploads,
        allow_signups: !!v.allow_signups,
      });
    }
  }, [data]);

  const save = useMutation({
    // PATCH expects { values: { key: val } }.
    mutationFn: () =>
      adminApi.updatePlatformSettings({
        values: {
          announcement: form.announcement,
          support_email: form.support_email.trim(),
          allow_avatar_uploads: form.allow_avatar_uploads,
          allow_signups: form.allow_signups,
        },
      }),
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["platform", "settings"] });
    },
    onError: (err) => toast.error(apiError(err, "Could not save settings")),
  });

  function onSubmit(e) {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  }

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card icon={SlidersHorizontal} title="Platform settings" subtitle="Defaults applied across all tenants.">
      {isLoading ? (
        <CardSkeleton />
      ) : isError ? (
        <p className="text-sm text-red-300">{apiError(error, "Failed to load settings")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Announcement">
            <textarea
              value={form.announcement}
              onChange={(e) => set("announcement")(e.target.value)}
              placeholder="Shown as a platform-wide banner…"
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 hover:border-white/20"
            />
          </Field>
          <Field label="Support email">
            <input
              type="email"
              value={form.support_email}
              onChange={(e) => set("support_email")(e.target.value)}
              placeholder="support@platform.com"
              className={inputCls}
            />
          </Field>
          <Toggle
            label="Allow avatar uploads"
            description="Let tenant users upload profile pictures."
            checked={form.allow_avatar_uploads}
            onChange={set("allow_avatar_uploads")}
          />
          <Toggle
            label="Allow signups"
            description="Permit self-service registration."
            checked={form.allow_signups}
            onChange={set("allow_signups")}
          />
          <div className="flex justify-end pt-1">
            <SaveButton pending={save.isPending} />
          </div>
        </form>
      )}
    </Card>
  );
}

function MapsCard() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    google_maps_enabled: false,
    google_maps_api_key: "",
    google_maps_default_lat: "",
    google_maps_default_lng: "",
    google_maps_default_zoom: "",
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["platform", "settings"],
    queryFn: () => adminApi.getPlatformSettings(),
  });

  // The endpoint returns { catalog, values }; read the effective values map.
  useEffect(() => {
    const v = data?.values ?? data;
    if (v) {
      setForm({
        google_maps_enabled: !!v.google_maps_enabled,
        google_maps_api_key: v.google_maps_api_key ?? "",
        google_maps_default_lat: v.google_maps_default_lat ?? "",
        google_maps_default_lng: v.google_maps_default_lng ?? "",
        google_maps_default_zoom: v.google_maps_default_zoom ?? "",
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      adminApi.updatePlatformSettings({
        values: {
          google_maps_enabled: form.google_maps_enabled,
          google_maps_api_key: form.google_maps_api_key.trim(),
          google_maps_default_lat: Number(form.google_maps_default_lat) || 0,
          google_maps_default_lng: Number(form.google_maps_default_lng) || 0,
          google_maps_default_zoom: Number(form.google_maps_default_zoom) || 5,
        },
      }),
    onSuccess: () => {
      toast.success("Google Maps settings saved");
      qc.invalidateQueries({ queryKey: ["platform", "settings"] });
    },
    onError: (err) => toast.error(apiError(err, "Could not save Google Maps settings")),
  });

  function onSubmit(e) {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  }

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card icon={MapIcon} title="Google Maps" subtitle="API key + default map centre for the Sites Map.">
      {isLoading ? (
        <CardSkeleton />
      ) : isError ? (
        <p className="text-sm text-red-300">{apiError(error, "Failed to load settings")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Toggle
            label="Enable Google Maps"
            description="Render the Sites Map with Google Maps."
            checked={form.google_maps_enabled}
            onChange={set("google_maps_enabled")}
          />
          <Field label="Maps API key">
            <input
              type="password"
              autoComplete="off"
              value={form.google_maps_api_key}
              onChange={(e) => set("google_maps_api_key")(e.target.value)}
              placeholder="AIza…"
              className={inputCls}
            />
            <p className="text-xs text-slate-500">Restrict the key by HTTP referrer in Google Cloud Console.</p>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Default lat">
              <input
                type="number"
                step="any"
                value={form.google_maps_default_lat}
                onChange={(e) => set("google_maps_default_lat")(e.target.value)}
                placeholder="22.9734"
                className={inputCls}
              />
            </Field>
            <Field label="Default lng">
              <input
                type="number"
                step="any"
                value={form.google_maps_default_lng}
                onChange={(e) => set("google_maps_default_lng")(e.target.value)}
                placeholder="78.6569"
                className={inputCls}
              />
            </Field>
            <Field label="Default zoom">
              <input
                type="number"
                min="1"
                max="22"
                value={form.google_maps_default_zoom}
                onChange={(e) => set("google_maps_default_zoom")(e.target.value)}
                placeholder="5"
                className={inputCls}
              />
            </Field>
          </div>
          <div className="flex justify-end pt-1">
            <SaveButton pending={save.isPending} />
          </div>
        </form>
      )}
    </Card>
  );
}

function BrandingCard() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ app_name: "", logo_url: "", name_in_header: false });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["platform", "branding"],
    queryFn: () => adminApi.getPlatformBranding(),
  });

  useEffect(() => {
    if (data) {
      setForm({
        app_name: data.app_name ?? "",
        logo_url: data.logo_url ?? "",
        name_in_header: !!data.name_in_header,
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      adminApi.updatePlatformBranding({
        app_name: form.app_name.trim(),
        logo_url: form.logo_url.trim(),
        name_in_header: form.name_in_header,
      }),
    onSuccess: () => {
      toast.success("Branding saved");
      qc.invalidateQueries({ queryKey: ["platform", "branding"] });
    },
    onError: (err) => toast.error(apiError(err, "Could not save branding")),
  });

  function onSubmit(e) {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  }

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card icon={Palette} title="Branding" subtitle="Default look tenants inherit.">
      {isLoading ? (
        <CardSkeleton />
      ) : isError ? (
        <p className="text-sm text-red-300">{apiError(error, "Failed to load branding")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="App name">
            <input
              type="text"
              value={form.app_name}
              onChange={(e) => set("app_name")(e.target.value)}
              placeholder="Neubit"
              className={inputCls}
            />
          </Field>
          <Field label="Logo URL">
            <input
              type="url"
              value={form.logo_url}
              onChange={(e) => set("logo_url")(e.target.value)}
              placeholder="https://…/logo.svg"
              className={inputCls}
            />
          </Field>
          {form.logo_url ? (
            <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={form.logo_url} alt="Logo preview" className="h-8 w-auto max-w-[140px] object-contain" />
              <span className="text-xs text-slate-500">Logo preview</span>
            </div>
          ) : null}
          <Toggle
            label="Show name in header"
            description="Display the app name alongside the logo."
            checked={form.name_in_header}
            onChange={set("name_in_header")}
          />
          <div className="flex justify-end pt-1">
            <SaveButton pending={save.isPending} />
          </div>
        </form>
      )}
    </Card>
  );
}
