"use client";

// Read-only preview: renders the actual email HTML in an isolated iframe so its
// own styles don't leak into the app (and vice-versa) — an enterprise touch.
import { useQuery } from "@tanstack/react-query";

import { Button, Modal, Spinner } from "@/components/ui/kit";
import { api } from "@/lib/api";

export default function PreviewModal({ name, onClose }) {
  // Rendered with sample data + branded shell on the server (not raw Jinja).
  const detail = useQuery({
    queryKey: ["messaging-template-preview", name],
    queryFn: () => api.get(`/messaging/templates/${name}/preview`).then((r) => r.data),
    enabled: !!name,
  });
  const d = detail.data;

  return (
    <Modal
      open={!!name}
      onClose={onClose}
      wide
      title={`Preview · ${name}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {detail.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <span className="block text-xs font-medium text-muted mb-1">Subject</span>
            <div className="rounded-lg border border-card-border bg-hover px-3 py-2 text-sm text-foreground">
              {d?.subject || "—"}
            </div>
          </div>
          <div>
            <span className="block text-xs font-medium text-muted mb-1">Rendered email</span>
            <iframe
              title="Email preview"
              srcDoc={d?.html || "<p style='font-family:sans-serif;color:#666'>This template has no body.</p>"}
              className="w-full h-[440px] rounded-lg border border-card-border bg-white"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
