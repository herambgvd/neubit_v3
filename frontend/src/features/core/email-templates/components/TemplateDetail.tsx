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
import { blocksToHtml, htmlToBlocks, type Block } from "../blocks";
import BlockEditor from "./BlockEditor";
import { TEMPLATE_META, titleCase } from "../constants";

type View = "design" | "html" | "preview";

const TABS: { key: View; label: string; icon: string }[] = [
  { key: "design", label: "Design", icon: "heroicons-outline:squares-2x2" },
  { key: "html", label: "HTML", icon: "heroicons-outline:code-bracket" },
  { key: "preview", label: "Preview", icon: "heroicons-outline:eye" },
];

export default function TemplateDetail({
  name,
  onGone,
}: {
  name: string;
  /** A custom template has no default to fall back to — the list must reselect. */
  onGone?: () => void;
}) {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("design");
  const [form, setForm] = useState({ subject: "", html: "" });
  // null = this HTML was not produced by the designer, so it cannot be shown as
  // blocks without inventing a structure for it. See ../blocks.
  const [blocks, setBlocks] = useState<Block[] | null>(null);

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
    if (!detail.data) return;
    setForm({ subject: detail.data.subject || "", html: detail.data.html || "" });
    setBlocks(htmlToBlocks(detail.data.html || ""));
  }, [detail.data, name]);

  /** Editing a block rewrites the HTML — the blocks ARE the source, once adopted. */
  const setBlocksAndHtml = (next: Block[]) => {
    setBlocks(next);
    setForm((f) => ({ ...f, html: blocksToHtml(next) }));
  };

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
      toast.success(isBuiltin ? "Reverted to the built-in default" : "Template deleted");
      onGone?.();
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const meta = TEMPLATE_META[name];
  const overridden = !!detail.data?.is_override;
  const isBuiltin = detail.data?.is_builtin !== false;
  const variables = detail.data?.variables || [];

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
          {/* DISABLED, not absent, when there is nothing to undo. The endpoint 404s
              on a template with no override, so it must not be clickable — but a
              control that vanishes reads as a missing feature, and an admin looking
              for "where do I delete this" finds nothing to explain itself. It is
              shown greyed with the reason on hover. */}
          {(overridden || isBuiltin) && (
            <QuietButton
              icon={isBuiltin ? "heroicons-outline:arrow-uturn-left" : "heroicons-outline:trash"}
              disabled={revert.isPending || !overridden}
              title={
                overridden
                  ? undefined
                  : "This template is already the built-in default — there is nothing to revert."
              }
              onClick={() => revert.mutate()}
            >
              {revert.isPending
                ? isBuiltin
                  ? "Reverting…"
                  : "Deleting…"
                : isBuiltin
                  ? "Revert to default"
                  : "Delete template"}
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
        ) : view === "design" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div>
              <Input
                label="Subject"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
              {variables.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="text-[10.5px] text-nb-faint">Insert:</span>
                  {variables.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, subject: `${f.subject}{{ ${v} }}` }))}
                      className="rounded-[6px] border border-nb-line px-1.5 py-0.5 font-mono text-[10.5px] text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {blocks ? (
              <BlockEditor blocks={blocks} onChange={setBlocksAndHtml} variables={variables} />
            ) : (
              // The honest refusal. This template's HTML was hand-written or is a
              // built-in default with `{% if %}` branches; approximating it as
              // blocks would silently drop whatever they cannot represent the
              // moment it is saved. Starting fresh is an explicit choice.
              <div className="rounded-[10px] border border-nb-line bg-[rgba(255,255,255,.02)] p-5 text-center">
                <p className="text-sm text-nb-ink">This template was not built in the designer.</p>
                <p className="mx-auto mt-1 max-w-md text-[12px] text-nb-faint">
                  Its HTML has logic the designer cannot represent, so opening it as blocks
                  would quietly lose part of it. Edit it in the HTML tab, or start a new
                  design — which replaces the body.
                </p>
                <div className="mt-3">
                  <QuietButton
                    icon="heroicons-outline:squares-2x2"
                    onClick={() => setBlocksAndHtml([])}
                  >
                    Start a design
                  </QuietButton>
                </div>
              </div>
            )}
          </div>
        ) : view === "html" ? (
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
              onChange={(e) => {
                setForm({ ...form, html: e.target.value });
                // Hand-editing detaches it from the designer unless the marker
                // survives — otherwise the two views would disagree about which
                // one is the source.
                setBlocks(htmlToBlocks(e.target.value));
              }}
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
