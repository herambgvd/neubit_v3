"use client";

// Edit modal for a single transactional email template — subject + HTML body,
// with save and (when overridden) revert-to-default actions. Owns its own detail
// query + mutations; opened/closed by the parent via the `name` prop.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Input, Modal, Spinner, Textarea } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";

export default function TemplateModal({ name, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ subject: "", html: "" });

  const detail = useQuery({
    queryKey: ["messaging-template", name],
    queryFn: () => api.get(`/messaging/templates/${name}`).then((r) => r.data),
    enabled: !!name,
  });

  useEffect(() => {
    if (detail.data) setForm({ subject: detail.data.subject || "", html: detail.data.html || "" });
  }, [detail.data]);

  const save = useMutation({
    mutationFn: () => api.put(`/messaging/templates/${name}`, form),
    onSuccess: () => {
      toast.success("Template saved");
      qc.invalidateQueries({ queryKey: ["messaging-templates"] });
      qc.invalidateQueries({ queryKey: ["messaging-template", name] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const revert = useMutation({
    mutationFn: () => api.delete(`/messaging/templates/${name}`),
    onSuccess: () => {
      toast.success("Reverted to default");
      qc.invalidateQueries({ queryKey: ["messaging-templates"] });
      qc.invalidateQueries({ queryKey: ["messaging-template", name] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal
      open={!!name}
      onClose={onClose}
      wide
      title={`Template · ${name}`}
      footer={
        <>
          {detail.data?.is_override && (
            <Button
              variant="danger"
              icon="heroicons-outline:arrow-uturn-left"
              className="mr-auto"
              disabled={revert.isPending}
              onClick={() => revert.mutate()}
            >
              {revert.isPending ? "Reverting…" : "Revert to default"}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || detail.isLoading} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {detail.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <Input
            label="Subject"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            placeholder="Subject line…"
          />
          <Textarea
            label="HTML body"
            rows={14}
            className="font-mono !text-xs"
            value={form.html}
            onChange={(e) => setForm({ ...form, html: e.target.value })}
            placeholder="<html>…</html>"
          />
        </div>
      )}
    </Modal>
  );
}
