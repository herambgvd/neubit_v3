"use client";

// Branding — white-label the app name, colors and logo. Thin orchestrator: owns
// the branding query, form state (hydrated from the server), and the save +
// logo-upload mutations; wires the BrandingEditor + BrandingPreview columns.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import BrandingEditor from "./components/BrandingEditor";
import BrandingPreview from "./components/BrandingPreview";

const DEFAULTS = { app_name: "", primary_color: "#4f46e5", accent_color: "#22d3ee", name_in_header: false };

export default function BrandingPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(DEFAULTS);

  const branding = useQuery({
    queryKey: ["branding"],
    queryFn: () => api.get("/branding").then((r) => r.data),
  });

  // Hydrate the form whenever the server data lands / refreshes.
  useEffect(() => {
    if (branding.data) {
      setForm({
        app_name: branding.data.app_name || "",
        primary_color: branding.data.primary_color || DEFAULTS.primary_color,
        accent_color: branding.data.accent_color || DEFAULTS.accent_color,
        name_in_header: !!branding.data.name_in_header,
      });
    }
  }, [branding.data]);

  const save = useMutation({
    mutationFn: (body) => api.put("/branding", body),
    onSuccess: () => {
      toast.success("Branding saved");
      qc.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const uploadLogo = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post("/branding/logo", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => {
      toast.success("Logo updated");
      qc.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const logoUrl = branding.data?.logo_url;

  if (branding.isLoading) {
    return (
      <div>
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <Button
          icon="heroicons-outline:check"
          disabled={save.isPending}
          onClick={() => save.mutate(form)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <BrandingEditor
          form={form}
          setForm={setForm}
          logoUrl={logoUrl}
          onUploadLogo={(file) => uploadLogo.mutate(file)}
          uploading={uploadLogo.isPending}
        />
        <BrandingPreview form={form} logoUrl={logoUrl} />
      </div>
    </div>
  );
}
