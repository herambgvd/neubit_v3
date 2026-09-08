"use client";

// LinkageActionsBuilder — the actions list for a linkage rule. Each action is a
// { type, config } row; the type picks which config fields render. Add / remove
// actions; config edits bubble up via onChange(actions). Config stays a free dict
// so a field the backend ignores is harmless. Camera-bound actions (ptz_preset,
// trigger_output) show a camera picker when a specific camera is needed.
//
// Config fields per type (match vision linkage.actions.* config.get keys):
//   start_recording : pre_buffer_seconds, post_buffer_seconds (optional; camera-derived)
//   notify          : channel, target, template, subject, body
//   ptz_preset      : preset_token
//   trigger_output  : relay_token, state, release_after_seconds
//   popup           : reason
//   wall_display    : wall_id, monitor_id, cell_index, camera_source, camera_id?, hold_seconds?
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { videowall } from "@/features/videowall/api";

import { Input, Select } from "@/components/ui/kit";
import { LINKAGE_ACTION_TYPES } from "../constants";
import type { LinkageAction } from "../types";

const emptyAction = (type = "start_recording"): LinkageAction => ({ type, config: {} });

export interface LinkageActionsBuilderProps {
  actions?: LinkageAction[];
  onChange?: (next: LinkageAction[]) => void;
}

export default function LinkageActionsBuilder({ actions = [], onChange }: LinkageActionsBuilderProps) {
  const set = (next: LinkageAction[]) => onChange?.(next);

  const add = () => set([...actions, emptyAction()]);
  const remove = (idx: number) => set(actions.filter((_, i) => i !== idx));
  const patchType = (idx: number, type: string) =>
    set(actions.map((a, i) => (i === idx ? { type, config: {} } : a)));
  const patchConfig = (idx: number, key: string, value: unknown) =>
    patchConfigs(idx, { [key]: value });

  // SEVERAL keys in ONE update. Two patchConfig calls in one handler both read
  // the same `actions` prop — this component is controlled — so the second
  // overwrites the first and the earlier key is silently lost. That is exactly
  // what "pick a wall" needs (set the wall, clear the monitor).
  const patchConfigs = (idx: number, patch: Record<string, unknown>) =>
    set(
      actions.map((a, i) => (i === idx ? { ...a, config: { ...(a.config || {}), ...patch } } : a)),
    );

  return (
    <div className="space-y-2">
      {actions.length === 0 && (
        <p className="rounded-md border border-dashed border-card-border px-3 py-4 text-center text-[11px] text-muted">
          No actions yet. Add at least one action to make this rule do something.
        </p>
      )}

      {actions.map((action, idx) => {
        const meta = LINKAGE_ACTION_TYPES.find((t) => t.value === action.type);
        return (
          <div key={idx} className="rounded-lg border border-card-border bg-hover/30 p-3">
            <div className="flex items-center gap-2">
              <Icon icon={meta?.icon || "heroicons-outline:bolt"} className="text-sm text-muted" />
              <div className="w-52">
                <Select
                  value={action.type}
                  onChange={(e) => patchType(idx, e.target.value)}
                  options={LINKAGE_ACTION_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                  className="!h-8 !py-1"
                />
              </div>
              {meta?.hint && <span className="hidden text-[11px] text-muted sm:inline">{meta.hint}</span>}
              <button
                type="button"
                onClick={() => remove(idx)}
                title="Remove action"
                className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted hover:bg-card hover:text-red-500"
              >
                <Icon icon="heroicons-outline:trash" className="text-xs" />
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <ActionConfig action={action} idx={idx} patchConfig={patchConfig} patchConfigs={patchConfigs} />
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-card-border px-2.5 py-1.5 text-[11px] font-medium text-muted hover:bg-hover hover:text-foreground"
      >
        <Icon icon="heroicons-outline:plus" className="text-xs" /> Add action
      </button>
    </div>
  );
}

// The email template a notify action renders through core, or "—" for the plain
// subject/body pair below it. This is what makes an authored template reachable:
// without a rule able to NAME one, a custom template had no sender.
//
// The list needs settings.manage, which a VMS rule editor may not hold — so a
// failed load degrades to a name field rather than hiding the feature. The name
// is what travels either way.
function NotifyTemplateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const templates = useQuery({
    queryKey: ["messaging-templates"],
    queryFn: () => api.get<{ name: string; subject: string }[]>("/messaging/templates").then((r) => r.data),
    retry: false,
  });
  const items = templates.data;

  return (
    <Cfg label="Email template" span={2}>
      {items && items.length > 0 ? (
        <Select
          ariaLabel="Email template"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: "", label: "None — use the subject and body below" },
            ...items.map((t) => ({ value: t.name, label: t.name })),
          ]}
          className="!h-9 !py-1.5"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="template name (blank = plain subject and body)"
        />
      )}
    </Cfg>
  );
}

// A tiny labelled input used inside the config grid.
function Cfg({ label, children, span = 1 }: { label: ReactNode; children: ReactNode; span?: 1 | 2 }) {
  // The control lives INSIDE the label, so the two are associated without an id
  // to thread through: a screen reader announces the field's name, and clicking
  // the caption focuses it. Sibling <label> text next to an input names nothing.
  return (
    <label className={`block ${span === 2 ? "col-span-2" : ""}`}>
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

interface ActionConfigProps {
  action: LinkageAction;
  idx: number;
  patchConfig: (idx: number, key: string, value: unknown) => void;
  /** Several keys in one update — see the note on patchConfigs. */
  patchConfigs: (idx: number, patch: Record<string, unknown>) => void;
}

function ActionConfig({ action, idx, patchConfig, patchConfigs }: ActionConfigProps) {
  const c: Record<string, unknown> = action.config || {};
  // Config is a free dict (see the header); these read a key as the input type
  // it binds to, and anything else as "unset".
  const str = (k: string): string => {
    const v = c[k];
    return typeof v === "string" ? v : "";
  };
  const numOrStr = (k: string): number | string => {
    const v = c[k];
    return typeof v === "number" || typeof v === "string" ? v : "";
  };
  const num = (v: string) => (v === "" || v == null ? undefined : Number(v));

  switch (action.type) {
    case "start_recording":
      return (
        <>
          <Cfg label="Pre-buffer (s)">
            <Input
              type="number"
              min={0}
              value={numOrStr("pre_buffer_seconds")}
              onChange={(e) => patchConfig(idx, "pre_buffer_seconds", num(e.target.value))}
              placeholder="camera default"
            />
          </Cfg>
          <Cfg label="Post-buffer (s)">
            <Input
              type="number"
              min={0}
              value={numOrStr("post_buffer_seconds")}
              onChange={(e) => patchConfig(idx, "post_buffer_seconds", num(e.target.value))}
              placeholder="camera default"
            />
          </Cfg>
        </>
      );

    case "notify":
      return (
        <>
          <Cfg label="Channel">
            <Select
              value={str("channel") || "email"}
              onChange={(e) => patchConfig(idx, "channel", e.target.value)}
              options={[
                { value: "email", label: "Email" },
                { value: "webhook", label: "Webhook" },
                { value: "push", label: "Push" },
              ]}
              className="!h-9 !py-1.5"
            />
          </Cfg>
          <Cfg label="Target (address / URL)">
            <Input value={str("target")} onChange={(e) => patchConfig(idx, "target", e.target.value)} placeholder="ops@site / https://…" />
          </Cfg>
          <NotifyTemplateField
            value={str("template")}
            onChange={(v) => patchConfig(idx, "template", v)}
          />
          {!str("template") && (
            <>
              <Cfg label="Subject">
                <Input value={str("subject")} onChange={(e) => patchConfig(idx, "subject", e.target.value)} placeholder="VMS: {event}" />
              </Cfg>
              <Cfg label="Body">
                <Input value={str("body")} onChange={(e) => patchConfig(idx, "body", e.target.value)} placeholder="uses the event reason if blank" />
              </Cfg>
            </>
          )}
        </>
      );

    case "ptz_preset":
      return (
        <Cfg label="Preset token" span={2}>
          <Input value={str("preset_token")} onChange={(e) => patchConfig(idx, "preset_token", e.target.value)} placeholder="e.g. Preset1 / a preset token" />
        </Cfg>
      );

    case "trigger_output":
      return (
        <>
          <Cfg label="Relay token">
            <Input value={str("relay_token")} onChange={(e) => patchConfig(idx, "relay_token", e.target.value)} placeholder="RelayOut1" />
          </Cfg>
          <Cfg label="State">
            <Select
              value={str("state") || "active"}
              onChange={(e) => patchConfig(idx, "state", e.target.value)}
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
              className="!h-9 !py-1.5"
            />
          </Cfg>
          <Cfg label="Auto-release after (s)" span={2}>
            <Input
              type="number"
              min={0}
              value={numOrStr("release_after_seconds")}
              onChange={(e) => patchConfig(idx, "release_after_seconds", num(e.target.value))}
              placeholder="0 = latch"
            />
          </Cfg>
        </>
      );

    case "popup":
      return (
        <Cfg label="Reason (shown to operator)" span={2}>
          <Input value={str("reason")} onChange={(e) => patchConfig(idx, "reason", e.target.value)} placeholder="uses the event reason if blank" />
        </Cfg>
      );

    case "wall_display":
      return (
        <WallDisplayFields
          idx={idx}
          str={str}
          numOrStr={numOrStr}
          num={num}
          patchConfig={patchConfig}
          patchConfigs={patchConfigs}
        />
      );

    default:
      return null;
  }
}

/**
 * The spot-monitor action: hold a camera on a wall cell, then put the cell back.
 *
 * Wall and monitor are PICKED, not typed: they are uuids, and a rule pointing at
 * a wall that does not exist fails at fire time — in the audit log, hours later,
 * on an alarm nobody was watching. The cell index is a number because a monitor's
 * layout (1/4/9/16) decides the range, and the picked monitor names its own.
 */
function WallDisplayFields({
  idx,
  str,
  numOrStr,
  num,
  patchConfig,
  patchConfigs,
}: {
  idx: number;
  str: (k: string) => string;
  numOrStr: (k: string) => number | string;
  num: (v: string) => number | undefined;
  patchConfig: (idx: number, key: string, value: unknown) => void;
  patchConfigs: (idx: number, patch: Record<string, unknown>) => void;
}) {
  const wallId = str("wall_id");
  const wallsQ = useQuery({
    queryKey: ["vms-walls", "linkage-action"],
    queryFn: () => videowall.walls.list({ limit: 100 }),
    staleTime: 60_000,
    retry: false,
  });
  const monitorsQ = useQuery({
    queryKey: ["vms-wall-monitors", wallId],
    queryFn: () => videowall.monitors.list(wallId),
    enabled: !!wallId,
    staleTime: 60_000,
    retry: false,
  });
  const walls = wallsQ.data?.items || [];
  const monitors = monitorsQ.data?.items || [];
  const monitor = monitors.find((m) => m.id === str("monitor_id"));
  const cells = monitor?.layout || 0;

  return (
    <>
      <Cfg label="Wall">
        <Select
          ariaLabel="Wall"
          value={wallId}
          // A monitor belongs to ONE wall, so picking a wall clears the monitor —
          // in ONE update, or the second write would drop the first.
          onChange={(e) => patchConfigs(idx, { wall_id: e.target.value, monitor_id: "" })}
          options={[
            { value: "", label: walls.length ? "Select a wall" : "No walls configured" },
            ...walls.map((w) => ({ value: w.id, label: w.name })),
          ]}
          className="!h-9 !py-1.5"
        />
      </Cfg>
      <Cfg label="Monitor">
        <Select
          ariaLabel="Monitor"
          value={str("monitor_id")}
          onChange={(e) => patchConfig(idx, "monitor_id", e.target.value)}
          options={[
            { value: "", label: wallId ? "Select a monitor" : "Pick a wall first" },
            ...monitors.map((m) => ({ value: m.id, label: m.name })),
          ]}
          className="!h-9 !py-1.5"
        />
      </Cfg>
      <Cfg label={cells ? `Cell (0–${cells - 1})` : "Cell"}>
        <Input
          type="number"
          min={0}
          max={cells ? cells - 1 : undefined}
          value={numOrStr("cell_index")}
          onChange={(e) => patchConfig(idx, "cell_index", num(e.target.value))}
          placeholder="0"
        />
      </Cfg>
      <Cfg label="Hold (s)">
        <Input
          type="number"
          min={0}
          value={numOrStr("hold_seconds")}
          onChange={(e) => patchConfig(idx, "hold_seconds", num(e.target.value))}
          // The engine's own default, stated rather than silently applied.
          placeholder="30 — 0 keeps it on the cell"
        />
      </Cfg>
      <Cfg label="Camera" span={2}>
        <Select
          ariaLabel="Camera"
          value={str("camera_source") || "event"}
          onChange={(e) => patchConfig(idx, "camera_source", e.target.value)}
          options={[
            { value: "event", label: "The camera that raised the event" },
            { value: "explicit", label: "A fixed camera (id below)" },
          ]}
          className="!h-9 !py-1.5"
        />
      </Cfg>
      {str("camera_source") === "explicit" && (
        <Cfg label="Camera id" span={2}>
          <Input
            value={str("camera_id")}
            onChange={(e) => patchConfig(idx, "camera_id", e.target.value)}
            placeholder="camera id to display"
          />
        </Cfg>
      )}
    </>
  );
}
