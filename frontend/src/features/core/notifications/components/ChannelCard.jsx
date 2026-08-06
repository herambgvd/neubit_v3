"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ActionButton, QuietButton, SectionCard } from "@/components/console";
import { Badge, Input, Toggle } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";

import { CHANNEL_FIELDS, CHANNEL_META } from "../constants";

export function ChannelCard({ channel }) {
  const qc = useQueryClient();
  const fields = CHANNEL_FIELDS[channel.channel] || [];
  const meta = CHANNEL_META[channel.channel] || { title: channel.channel, icon: "heroicons-outline:cog-6-tooth" };

  const [enabled, setEnabled] = useState(channel.enabled);
  const [config, setConfig] = useState(channel.config || {});
  // Track which fields the admin actually edited, so we can avoid re-sending
  // masked secrets (value "***" means unchanged).
  const [dirty, setDirty] = useState({});

  useEffect(() => {
    setEnabled(channel.enabled);
    setConfig(channel.config || {});
    setDirty({});
  }, [channel]);

  const save = useMutation({
    mutationFn: () => {
      const out = {};
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

  const setField = (key, value) => {
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
        <Toggle checked={enabled} onChange={setEnabled} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) =>
          f.type === "bool" ? (
            <div key={f.key} className="flex items-center justify-between rounded-[10px] border border-nb-line px-3 py-2.5">
              <span className="text-sm font-medium text-nb-muted">{f.label}</span>
              <Toggle checked={!!config[f.key]} onChange={(v) => setField(f.key, v)} />
            </div>
          ) : (
            <Input
              key={f.key}
              label={f.label}
              type={f.type || "text"}
              value={config[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          ),
        )}
      </div>

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
