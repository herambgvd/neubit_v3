"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, Loader2, Map as MapIcon, Palette, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";
import { Button, Card, Field, Input, PageHeader, Skeleton, Switch, Textarea } from "@/components/ui";

export default function PlatformSettingsPage() {
  return (
    <div>
      <PageHeader
        title="Platform"
        description="Platform-wide defaults every tenant inherits. Individual tenants can override these in their own settings."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsCard />
        <BrandingCard />
        <MapsCard />
      </div>
    </div>
  );
}

function SettingsSection({ icon: Icon, title, subtitle, children }) {
  return (
    <Card className="animate-fade-in p-6">
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-accent">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
      </div>
      {children}
    </Card>
  );
}

function Toggle({ label, description, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border border-card-border bg-card px-3.5 py-3">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted">{description}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-11 rounded-lg" />
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
    <SettingsSection icon={SlidersHorizontal} title="Platform settings" subtitle="Defaults applied across all tenants.">
      {isLoading ? (
        <CardSkeleton />
      ) : isError ? (
        <p className="text-sm text-danger">{apiError(error, "Failed to load settings")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Announcement">
            <Textarea
              value={form.announcement}
              onChange={(e) => set("announcement")(e.target.value)}
              placeholder="Shown as a platform-wide banner…"
              rows={3}
            />
          </Field>
          <Field label="Support email">
            <Input
              type="email"
              value={form.support_email}
              onChange={(e) => set("support_email")(e.target.value)}
              placeholder="support@platform.com"
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
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </SettingsSection>
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
    <SettingsSection icon={MapIcon} title="Google Maps" subtitle="API key + default map centre for the Sites Map.">
      {isLoading ? (
        <CardSkeleton />
      ) : isError ? (
        <p className="text-sm text-danger">{apiError(error, "Failed to load settings")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Toggle
            label="Enable Google Maps"
            description="Render the Sites Map with Google Maps."
            checked={form.google_maps_enabled}
            onChange={set("google_maps_enabled")}
          />
          <Field label="Maps API key" hint="Restrict the key by HTTP referrer in Google Cloud Console.">
            <Input
              type="password"
              autoComplete="off"
              value={form.google_maps_api_key}
              onChange={(e) => set("google_maps_api_key")(e.target.value)}
              placeholder="AIza…"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Default lat">
              <Input type="number" step="any" value={form.google_maps_default_lat} onChange={(e) => set("google_maps_default_lat")(e.target.value)} placeholder="22.9734" />
            </Field>
            <Field label="Default lng">
              <Input type="number" step="any" value={form.google_maps_default_lng} onChange={(e) => set("google_maps_default_lng")(e.target.value)} placeholder="78.6569" />
            </Field>
            <Field label="Default zoom">
              <Input type="number" min="1" max="22" value={form.google_maps_default_zoom} onChange={(e) => set("google_maps_default_zoom")(e.target.value)} placeholder="5" />
            </Field>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}

function BrandingCard() {
  const qc = useQueryClient();
  const fileRef = useRef(null);
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

  const uploadLogo = useMutation({
    mutationFn: (file) => adminApi.uploadPlatformLogo(file),
    onSuccess: (res) => {
      setForm((f) => ({ ...f, logo_url: res?.logo_url ?? f.logo_url }));
      toast.success("Logo uploaded");
      qc.invalidateQueries({ queryKey: ["platform", "branding"] });
    },
    onError: (err) => toast.error(apiError(err, "Could not upload logo")),
  });

  const save = useMutation({
    mutationFn: () =>
      adminApi.updatePlatformBranding({
        app_name: form.app_name.trim(),
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

  function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file (SVG, PNG, …)");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Logo must be under 2 MB");
      return;
    }
    uploadLogo.mutate(file);
  }

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <SettingsSection icon={Palette} title="Branding" subtitle="Default look tenants inherit.">
      {isLoading ? (
        <CardSkeleton />
      ) : isError ? (
        <p className="text-sm text-danger">{apiError(error, "Failed to load branding")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="App name">
            <Input value={form.app_name} onChange={(e) => set("app_name")(e.target.value)} placeholder="Neubit" />
          </Field>
          <Field label="Logo">
            <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} className="hidden" />
            <div className="flex items-center gap-3 rounded-lg border border-card-border bg-card px-3.5 py-3">
              {form.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.logo_url} alt="Logo preview" className="h-9 w-auto max-w-[140px] shrink-0 object-contain" />
              ) : (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-card-border bg-hover text-muted">
                  <ImageUp className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {form.logo_url ? "Current logo" : "No logo uploaded"}
                </div>
                <div className="text-xs text-muted">SVG, PNG or JPG · up to 2 MB</div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileRef.current?.click()}
                loading={uploadLogo.isPending}
              >
                {!uploadLogo.isPending && <ImageUp className="h-4 w-4" />}
                {form.logo_url ? "Replace" : "Upload"}
              </Button>
            </div>
          </Field>
          <Toggle
            label="Show name in header"
            description="Display the app name alongside the logo."
            checked={form.name_in_header}
            onChange={set("name_in_header")}
          />
          <div className="flex justify-end pt-1">
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}
