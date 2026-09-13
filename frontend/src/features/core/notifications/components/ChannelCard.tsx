"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ActionButton, QuietButton, SectionCard } from "@/components/console";
import { Badge, Input, Toggle } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import type { ChannelOut } from "../../types";

import { CHANNEL_FIELDS, CHANNEL_META } from "../constants";

/** A stored config value as editor text. `config` is unknown-valued, and only a
 *  scalar has a text form the operator can meaningfully edit. */
function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v);
}

export function ChannelCard({ channel }: { channel: ChannelOut }) {
  const qc = useQueryClient();
  const fields = CHANNEL_FIELDS[channel.channel] || [];
  const textFields = fields.filter((f) => f.type !== "bool");
  const boolFields = fields.filter((f) => f.type === "bool");
  const meta = CHANNEL_META[channel.channel] || { title: channel.channel, icon: "heroicons-outline:cog-6-tooth" };

  const [enabled, setEnabled] = useState(channel.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>(channel.config || {});
  // Track which fields the admin actually edited, so we can avoid re-sending
  // masked secrets (value "***" means unchanged).
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setEnabled(channel.enabled);
    setConfig(channel.config || {});
    setDirty({});
  }, [channel]);

  const save = useMutation({
    mutationFn: () => {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const v = config[f.key];
        if (f.type === "password") {
          if (dirty[f.key] && v !== "***") out[f.key] = v;
        } else {
          out[f.key] = v;
        }
      }
      return api.put(`/messaging/channels/${channel.channel}`, { enabled, config: out });
    },
    onSuccess: () => {
      toast.success(`${meta.title} saved`);
      qc.invalidateQueries({ queryKey: ["messaging-channels"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const test = useMutation({
    mutationFn: () => api.post(`/messaging/channels/${channel.channel}/test`),
    onSuccess: () => toast.success("Test message sent"),
    onError: (e) => toast.error(apiError(e)),
  });

  const setField = (key: string, value: unknown) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty((d) => ({ ...d, [key]: true }));
  };

  return (
    <SectionCard>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={meta.icon} className="shrink-0 text-sm text-nb-blueb" />
          <span className="truncate text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            {meta.title}
          </span>
          <Badge color={enabled ? "green" : "slate"}>{enabled ? "Enabled" : "Disabled"}</Badge>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label={`Enable ${meta.title}`} />
      </div>

      {/* Values first, then switches. A bool used to sit INSIDE this grid, so
          "Use TLS" was a full-height bordered box the size of a text input with a
          label and a toggle rattling around in it — and it aligned with nothing,
          because an Input carries its label above the box and that one carried it
          inside. Switches are their own compact row underneath now. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {textFields.map((f) => (
          <Input
            key={f.key}
            label={f.label}
            type={f.type || "text"}
            // Text fields hold strings on the wire (a masked secret is "***").
            // A non-scalar would be saved back as its own stringification, so it
            // reads as empty and the operator retypes it rather than losing it.
            value={textOf(config[f.key])}
            placeholder={f.placeholder}
            onChange={(e) => setField(f.key, e.target.value)}
          />
        ))}
      </div>

      {boolFields.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
          {boolFields.map((f) => (
            <label key={f.key} className="flex cursor-pointer items-center gap-1.5">
              <Toggle checked={!!config[f.key]} onChange={(v) => setField(f.key, v)} label={f.label} />
              <span className="text-sm text-nb-muted">{f.label}</span>
            </label>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <ActionButton icon="heroicons-outline:check" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </ActionButton>
        <QuietButton
          icon="heroicons-outline:paper-airplane"
          disabled={test.isPending || !enabled}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "Sending…" : "Send test"}
        </QuietButton>
      </div>
    </SectionCard>
  );
}
