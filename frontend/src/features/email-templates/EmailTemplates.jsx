"use client";

// Email Templates — customize the transactional emails the platform sends, or
// revert to defaults. Thin orchestrator: owns the templates query + which
// template is open for preview/edit; renders a grid of TemplateCard tiles and
// the Preview/Template modals.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader, Spinner } from "@/components/ui/kit";
import { api } from "@/lib/api";
import TemplateCard from "./components/TemplateCard";
import PreviewModal from "./components/PreviewModal";
import TemplateModal from "./components/TemplateModal";

export default function EmailTemplatesPage() {
  const [openTemplate, setOpenTemplate] = useState(null);
  const [previewName, setPreviewName] = useState(null);

  const templates = useQuery({
    queryKey: ["messaging-templates"],
    queryFn: () => api.get("/messaging/templates").then((r) => r.data),
  });

  return (
    <div>
      <PageHeader
        title="Email Templates"
        subtitle="Customize the transactional emails your platform sends, or revert them to defaults."
      />

      {templates.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(templates.data || []).map((t) => (
            <TemplateCard
              key={t.name}
              template={t}
              onPreview={() => setPreviewName(t.name)}
              onEdit={() => setOpenTemplate(t.name)}
            />
          ))}
        </div>
      )}

      <PreviewModal name={previewName} onClose={() => setPreviewName(null)} />
      <TemplateModal name={openTemplate} onClose={() => setOpenTemplate(null)} />
    </div>
  );
}
