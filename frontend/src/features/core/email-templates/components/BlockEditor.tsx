"use client";

// The visual designer: an operator builds the email out of blocks instead of
// writing Jinja-in-HTML, which is not a reasonable thing to ask of them.
//
// Placeholders are OFFERED, not typed from memory: each field carries the list of
// values this template is actually rendered with (served by the API — see
// TEMPLATE_VARIABLES in messaging/templates.py), and clicking one inserts it.
import { Icon } from "@iconify/react";

import { QuietButton } from "@/components/console";
import { Input, Select, Textarea } from "@/components/ui/kit";
import { BLOCK_LABELS, newBlock, type Block, type BlockType } from "../blocks";

export interface BlockEditorProps {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  /** Placeholders this template is rendered with, from the API. */
  variables: string[];
}

const ADDABLE: BlockType[] = ["heading", "text", "button", "image", "divider", "spacer"];

/** Click a placeholder to append it to a field — nobody has to remember the syntax. */
function Placeholders({ variables, onInsert }: { variables: string[]; onInsert: (token: string) => void }) {
  if (!variables.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <span className="text-[10.5px] text-nb-faint">Insert:</span>
      {variables.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`{{ ${v} }}`)}
          className="rounded-[6px] border border-nb-line px-1.5 py-0.5 font-mono text-[10.5px] text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
        >
          {v}
        </button>
      ))}
    </div>
  );
}

export default function BlockEditor({ blocks, onChange, variables }: BlockEditorProps) {
  const patch = (id: string, changes: Partial<Block>) =>
    onChange(blocks.map((b) => (b.id === id ? { ...b, ...changes } : b)));
  const remove = (id: string) => onChange(blocks.filter((b) => b.id !== id));
  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {blocks.length === 0 && (
          <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-6 text-center text-[12px] text-nb-faint">
            Nothing in this email yet — add a block below.
          </p>
        )}

        {blocks.map((b, i) => (
          <div key={b.id} className="rounded-[10px] border border-nb-line bg-[rgba(255,255,255,.02)] p-3">
            <div className="mb-2 flex items-center gap-2">
              <Icon icon={BLOCK_LABELS[b.type].icon} className="text-sm text-nb-blueb" />
              <span className="text-[11px] font-semibold uppercase tracking-[1.2px] text-nb-muted">
                {BLOCK_LABELS[b.type].label}
              </span>
              <span className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  aria-label={`Move ${BLOCK_LABELS[b.type].label} up`}
                  className="rounded-[6px] p-1 text-nb-faint transition hover:text-nb-ink disabled:opacity-30"
                >
                  <Icon icon="heroicons:chevron-up" className="text-sm" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === blocks.length - 1}
                  title="Move down"
                  aria-label={`Move ${BLOCK_LABELS[b.type].label} down`}
                  className="rounded-[6px] p-1 text-nb-faint transition hover:text-nb-ink disabled:opacity-30"
                >
                  <Icon icon="heroicons:chevron-down" className="text-sm" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(b.id)}
                  title="Remove"
                  aria-label={`Remove ${BLOCK_LABELS[b.type].label}`}
                  className="rounded-[6px] p-1 text-nb-faint transition hover:text-nb-crit"
                >
                  <Icon icon="heroicons-outline:trash" className="text-sm" />
                </button>
              </span>
            </div>

            {b.type === "heading" && (
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <div>
                  <Input
                    aria-label="Heading text"
                    value={b.text || ""}
                    onChange={(e) => patch(b.id, { text: e.target.value })}
                  />
                  <Placeholders
                    variables={variables}
                    onInsert={(t) => patch(b.id, { text: `${b.text || ""}${t}` })}
                  />
                </div>
                <Select
                  aria-label="Heading size"
                  value={String(b.level || 2)}
                  onChange={(e) => patch(b.id, { level: Number(e.target.value) as 2 | 3 })}
                  options={[
                    { value: "2", label: "Large" },
                    { value: "3", label: "Small" },
                  ]}
                />
                <Select
                  aria-label="Heading alignment"
                  value={b.align || "left"}
                  onChange={(e) => patch(b.id, { align: e.target.value as Block["align"] })}
                  options={[
                    { value: "left", label: "Left" },
                    { value: "center", label: "Centre" },
                  ]}
                />
              </div>
            )}

            {b.type === "text" && (
              <div>
                <Textarea
                  aria-label="Paragraph text"
                  rows={3}
                  value={b.text || ""}
                  onChange={(e) => patch(b.id, { text: e.target.value })}
                />
                <Placeholders
                  variables={variables}
                  onInsert={(t) => patch(b.id, { text: `${b.text || ""}${t}` })}
                />
              </div>
            )}

            {b.type === "button" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  label="Label"
                  value={b.text || ""}
                  onChange={(e) => patch(b.id, { text: e.target.value })}
                />
                <div>
                  <Input
                    label="Link"
                    value={b.url || ""}
                    placeholder="https://… or {{ login_url }}"
                    onChange={(e) => patch(b.id, { url: e.target.value })}
                  />
                  <Placeholders variables={variables} onInsert={(t) => patch(b.id, { url: t })} />
                </div>
              </div>
            )}

            {b.type === "image" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  label="Image URL"
                  value={b.url || ""}
                  placeholder="https://…"
                  onChange={(e) => patch(b.id, { url: e.target.value })}
                />
                <Input
                  label="Alt text"
                  value={b.text || ""}
                  onChange={(e) => patch(b.id, { text: e.target.value })}
                />
              </div>
            )}

            {(b.type === "divider" || b.type === "spacer") && (
              <p className="text-[11.5px] text-nb-faint">Nothing to configure.</p>
            )}
          </div>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2 border-t border-nb-line pt-3">
        {ADDABLE.map((t) => (
          <QuietButton
            key={t}
            icon={BLOCK_LABELS[t].icon}
            onClick={() => onChange([...blocks, newBlock(t)])}
          >
            {BLOCK_LABELS[t].label}
          </QuietButton>
        ))}
      </div>
    </div>
  );
}
