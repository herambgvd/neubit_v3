"use client";

// LinkageActionsBuilder — the actions list for a linkage rule. Each action is a
// { type, config } row; the type picks which config fields render. Add / remove
// actions; config edits bubble up via onChange(actions). Config stays a free dict
// so a field the backend ignores is harmless. Camera-bound actions (ptz_preset,
// trigger_output) show a camera picker when a specific camera is needed.
//
// Config fields per type (match vision linkage.actions.* config.get keys):
//   start_recording : pre_buffer_seconds, post_buffer_seconds (optional; camera-derived)
//   notify          : channel, target, subject, body
//   ptz_preset      : preset_token
//   trigger_output  : relay_token, state, release_after_seconds
//   popup           : reason
import { Icon } from "@iconify/react";

import { Input, Select } from "@/components/ui/kit";
import { LINKAGE_ACTION_TYPES } from "../constants";

const emptyAction = (type = "start_recording") => ({ type, config: {} });

export default function LinkageActionsBuilder({ actions = [], onChange }) {
  const set = (next) => onChange?.(next);

  const add = () => set([...actions, emptyAction()]);
  const remove = (idx) => set(actions.filter((_, i) => i !== idx));
  const patchType = (idx, type) =>
    set(actions.map((a, i) => (i === idx ? { type, config: {} } : a)));
  const patchConfig = (idx, key, value) =>
    set(
      actions.map((a, i) =>
        i === idx ? { ...a, config: { ...(a.config || {}), [key]: value } } : a,
      ),
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
              <ActionConfig action={action} idx={idx} patchConfig={patchConfig} />
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

// A tiny labelled input used inside the config grid.
function Cfg({ label, children, span = 1 }) {
  return (
    <div className={span === 2 ? "col-span-2" : ""}>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted">{label}</label>
      {children}
    </div>
  );
}

function ActionConfig({ action, idx, patchConfig }) {
  const c = action.config || {};
  const num = (v) => (v === "" || v == null ? undefined : Number(v));

  switch (action.type) {
    case "start_recording":
      return (
        <>
          <Cfg label="Pre-buffer (s)">
            <Input
              type="number"
              min={0}
              value={c.pre_buffer_seconds ?? ""}
              onChange={(e) => patchConfig(idx, "pre_buffer_seconds", num(e.target.value))}
              placeholder="camera default"
            />
          </Cfg>
          <Cfg label="Post-buffer (s)">
            <Input
              type="number"
              min={0}
              value={c.post_buffer_seconds ?? ""}
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
              value={c.channel || "email"}
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
            <Input value={c.target || ""} onChange={(e) => patchConfig(idx, "target", e.target.value)} placeholder="ops@site / https://…" />
          </Cfg>
          <Cfg label="Subject">
            <Input value={c.subject || ""} onChange={(e) => patchConfig(idx, "subject", e.target.value)} placeholder="VMS: {event}" />
          </Cfg>
          <Cfg label="Body">
            <Input value={c.body || ""} onChange={(e) => patchConfig(idx, "body", e.target.value)} placeholder="uses the event reason if blank" />
          </Cfg>
        </>
      );

    case "ptz_preset":
      return (
        <Cfg label="Preset token" span={2}>
          <Input value={c.preset_token || ""} onChange={(e) => patchConfig(idx, "preset_token", e.target.value)} placeholder="e.g. Preset1 / a preset token" />
        </Cfg>
      );

    case "trigger_output":
      return (
        <>
          <Cfg label="Relay token">
            <Input value={c.relay_token || ""} onChange={(e) => patchConfig(idx, "relay_token", e.target.value)} placeholder="RelayOut1" />
          </Cfg>
          <Cfg label="State">
            <Select
              value={c.state || "active"}
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
              value={c.release_after_seconds ?? ""}
              onChange={(e) => patchConfig(idx, "release_after_seconds", num(e.target.value))}
              placeholder="0 = latch"
            />
          </Cfg>
        </>
      );

    case "popup":
      return (
        <Cfg label="Reason (shown to operator)" span={2}>
          <Input value={c.reason || ""} onChange={(e) => patchConfig(idx, "reason", e.target.value)} placeholder="uses the event reason if blank" />
        </Cfg>
      );

    default:
      return null;
  }
}
