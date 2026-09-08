"use client";

// Branding — white-label the app name, the logo and the favicon. Thin
// orchestrator: owns the branding query, the app-name form state, and the save +
// two upload mutations; wires the BrandingEditor + BrandingPreview columns.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ActionButton, LoadingBlock, ViewActions } from "@/components/console";
import { api, apiError } from "@/lib/api";
import type { BrandingOut } from "@/lib/types";
import type { BrandingForm } from "../types";
import BrandingEditor from "./components/BrandingEditor";
import BrandingPreview from "./components/BrandingPreview";

const DEFAULTS: BrandingForm = { app_name: "" };

export default function BrandingPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(DEFAULTS);

  const branding = useQuery({
    queryKey: ["branding"],
    queryFn: () => api.get<BrandingOut>("/branding").then((r) => r.data),
  });

  // Hydrate the form whenever the server data lands / refreshes.
  useEffect(() => {
    if (branding.data) {
      setForm({ app_name: branding.data.app_name || "" });
    }
  }, [branding.data]);

  const save = useMutation({
    mutationFn: (body: BrandingForm) => api.put("/branding", body),
    onSuccess: () => {
      toast.success("Branding saved");
      qc.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const uploadLogo = useMutation({
    mutationFn: (file: File) => {
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

  const uploadFavicon = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post("/branding/favicon", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => {
      toast.success("Favicon updated");
      // The tab icon is applied by TitleSync off this same query.
      qc.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const logoUrl = branding.data?.logo_url;
  const faviconUrl = branding.data?.favicon_url;

  if (branding.isLoading) return <LoadingBlock />;

  return (
    <div>
      <ViewActions>
        <ActionButton
          icon="heroicons-outline:check"
          disabled={save.isPending}
          onClick={() => save.mutate(form)}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </ActionButton>
      </ViewActions>

      {/* A column flow, matching the delivery cards below on the same page. Four
          cards of unequal height — Identity is one input, Logo and Favicon are
          equal, the preview is small — so a grid row would be as tall as its
          tallest cell and leave a band of nothing under the short ones. */}
      <div className="columns-1 gap-3 lg:columns-2 [&>*]:mb-3 [&>*]:break-inside-avoid">
        <BrandingEditor
          form={form}
          setForm={setForm}
          logoUrl={logoUrl}
          faviconUrl={faviconUrl}
          onUploadLogo={(file) => uploadLogo.mutate(file)}
          onUploadFavicon={(file) => uploadFavicon.mutate(file)}
          uploadingLogo={uploadLogo.isPending}
          uploadingFavicon={uploadFavicon.isPending}
        />
        <BrandingPreview form={form} logoUrl={logoUrl} faviconUrl={faviconUrl} />
      </div>
    </div>
  );
}
