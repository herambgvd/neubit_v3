"use client";

// The 70 of the 30:70 — one template, edited and seen.
//
// EDIT and PREVIEW are two views of the same template rather than two dialogs.
// The preview is the SERVER's render: it applies the branded shell, the sample
// data and the Jinja substitution, none of which the browser can reproduce — so
// it shows the SAVED template, and says so plainly while there are unsaved edits.
// Rendering a half-accurate local approximation of a real email would be worse
// than admitting the preview is one save behind.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ActionButton, QuietButton } from "@/components/console";
import { TabBar } from "@/components/common";
import { Input, Spinner, Textarea } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import type { TemplateOut, TemplatePreviewOut } from "../../types";
import { TEMPLATE_META, titleCase } from "../constants";

type View = "edit" | "preview";

const TABS: { key: View; label: string; icon: string }[] = [
  { key: "edit", label: "Edit", icon: "heroicons-outline:pencil-square" },
  { key: "preview", label: "Preview", icon: "heroicons-outline:eye" },
];

export default function TemplateDetail({ name }: { name: string }) {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("edit");
  const [form, setForm] = useState({ subject: "", html: "" });

  const detail = useQuery({
    queryKey: ["messaging-template", name],
    queryFn: () => api.get<TemplateOut>(`/messaging/templates/${name}`).then((r) => r.data),
  });

  const preview = useQuery({
    queryKey: ["messaging-template-preview", name],
    queryFn: () =>
      api.get<TemplatePreviewOut>(`/messaging/templates/${name}/preview`).then((r) => r.data),
    // Only fetched when it is actually being looked at — a rendered email is a
    // round trip through Jinja and the branding lookup.
    enabled: view === "preview",
  });

  // Re-seed whenever the loaded template changes, INCLUDING when the operator
  // switches to another one: without `name` in the deps the form would keep the
  // previous template's body while the header said otherwise.
  useEffect(() => {
    if (detail.data) setForm({ subject: detail.data.subject || "", html: detail.data.html || "" });
  }, [detail.data, name]);

  const dirty = useMemo(
    () =>
      !!detail.data &&
      (form.subject !== (detail.data.subject || "") || form.html !== (detail.data.html || "")),
    [form, detail.data],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["messaging-templates"] });
    qc.invalidateQueries({ queryKey: ["messaging-template", name] });
    qc.invalidateQueries({ queryKey: ["messaging-template-preview", name] });
  };

  const save = useMutation({
    mutationFn: () => api.put(`/messaging/templates/${name}`, form),
    onSuccess: () => {
      toast.success("Template saved");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const revert = useMutation({
    mutationFn: () => api.delete(`/messaging/templates/${name}`),
    onSuccess: () => {
      toast.success("Reverted to the built-in default");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const meta = TEMPLATE_META[name];
  const overridden = !!detail.data?.is_override;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-nb-line px-6 py-5">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb shrink-0">
            <Icon icon={meta?.icon || "heroicons-outline:envelope"} className="text-xl" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-nb-ink">{titleCase(name)}</h2>
            <p className="mt-0.5 text-xs text-nb-muted">
              {meta?.desc || "A transactional email this platform sends."}{" "}
              <span className={overridden ? "text-nb-teal" : "text-nb-faint"}>
                {overridden ? "Customised for this deployment." : "Using the built-in default."}
              </span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Revert only exists when there IS an override — the endpoint 404s
              otherwise, and offering it on a default template would be an action
              that cannot succeed. */}
          {overridden && (
            <QuietButton
              icon="heroicons-outline:arrow-uturn-left"
              disabled={revert.isPending}
              onClick={() => revert.mutate()}
            >
              {revert.isPending ? "Reverting…" : "Revert to default"}
            </QuietButton>
          )}
          <ActionButton
            icon="heroicons-outline:check"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </ActionButton>
        </div>
      </header>

      <TabBar tabs={TABS} active={view} onChange={setView} className="px-4" />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        {detail.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : detail.isError ? (
          <div className="rounded-[10px] border border-nb-crit/30 bg-nb-crit/10 px-3 py-3 text-sm text-nb-crit">
            {apiError(detail.error, "Couldn't load this template")}
          </div>
        ) : view === "edit" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <Input
              label="Subject"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              hint="Jinja placeholders like {{ app_name }} are substituted when the email is sent."
            />
            {/* The body grows into whatever the pane has left. A fixed `rows`
                left the editor short on a tall window and scrolling on a short
                one — and this is the field the screen exists for. */}
            <Textarea
              label="HTML body"
              value={form.html}
              onChange={(e) => setForm({ ...form, html: e.target.value })}
              className="font-mono !text-xs min-h-[220px] flex-1"
              wrapperClassName="flex min-h-0 flex-1 flex-col"
            />
          </div>
        ) : preview.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : preview.isError ? (
          <div className="rounded-[10px] border border-nb-crit/30 bg-nb-crit/10 px-3 py-3 text-sm text-nb-crit">
            {apiError(preview.error, "Couldn't render this template")}
          </div>
        ) : (
          <div className="space-y-3">
            {dirty && (
              <p className="rounded-[10px] border border-nb-warn/30 bg-nb-warn/10 px-3 py-2 text-[12px] text-nb-warn">
                This is the saved template. Save your changes to see them here — the
                preview is rendered by the server, with the branded shell and sample data.
              </p>
            )}
            <div>
              <span className="mb-1 block text-xs font-medium text-nb-muted">Subject</span>
              <div className="rounded-lg border border-nb-line bg-white/5 px-3 py-2 text-sm text-nb-ink">
                {preview.data?.subject || "—"}
              </div>
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-nb-muted">Rendered email</span>
              {/* An iframe, and a SANDBOXED one: this is stored HTML rendered with
                  the app's own origin one document away. `allow-same-origin` is
                  deliberately absent, so the frame cannot reach this page. */}
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={
                  preview.data?.html ||
                  "<p style='font-family:sans-serif;color:#666'>This template has no body.</p>"
                }
                className="h-[520px] w-full rounded-lg border border-nb-line bg-white"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
