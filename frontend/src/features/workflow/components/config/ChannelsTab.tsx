"use client";

// Where an incident notification actually goes out.
//
// The dispatcher has always read these rows — an email channel's SMTP host, a
// webhook's URL, a push channel's FCM key — and there was no screen to write
// one. So the notify action on a transition could be configured, the outbox
// filled, and every send fell back to whatever `VE_SMTP_*` happened to be in the
// environment, or failed with "no SMTP host configured" and no way to fix it
// from the console.
//
// Secrets are handled by the service, not here: they are encrypted at rest under
// the row's tenant key and come back REDACTED. The form submits what it was
// given, and the service restores the stored value for any field still holding
// the redaction marker — so editing a port cannot wipe a password.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  ConsoleGrid,
  ConsolePanel,
  EmptyPane,
  IconButton,
  PanelCounts,
  PanelHeader,
  PanelList,
} from "@/components/console";
import { Button, ConfirmDialog, Input, Modal, Select, Toggle, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "../../api";
import type { ChannelPublic, CreateChannelRequest } from "../../types";

/** The three connectors the dispatch task can actually resolve. A type with no
 *  connector would be a row that never delivers, so it is not offered. */
export const CHANNEL_TYPES = [
  { value: "email", label: "Email (SMTP)", icon: "heroicons-outline:envelope" },
  { value: "webhook", label: "Webhook", icon: "heroicons-outline:link" },
  { value: "mobile_push", label: "Mobile push", icon: "heroicons-outline:device-phone-mobile" },
] as const;

/** One config value as text. A connector alias can hold a whole object (a
 *  webhook's `headers`, say); showing its JSON is at least true, where plain
 *  stringification would put `[object Object]` on the panel. */
function configText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A config value the text editor can hold and hand back unchanged. Anything
 *  else has to ride around the form rather than through it. */
function isEditable(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** The fields each connector reads, in the order it reads them. Anything else in
 *  `config` is carried through untouched — the connectors accept aliases. */
const FIELDS: Record<string, { key: string; label: string; placeholder?: string; secret?: boolean }[]> = {
  email: [
    { key: "host", label: "SMTP host", placeholder: "smtp.example.com" },
    { key: "port", label: "Port", placeholder: "587" },
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
    { key: "from_address", label: "From address", placeholder: "alerts@example.com" },
  ],
  webhook: [
    { key: "url", label: "URL", placeholder: "https://hooks.example.com/incident" },
    { key: "secret", label: "Signing secret", secret: true },
  ],
  mobile_push: [
    { key: "server_key", label: "FCM server key", secret: true },
  ],
};

const typeMeta = (t: string) => CHANNEL_TYPES.find((c) => c.value === t);

export default function ChannelsTab() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelPublic | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const q = useQuery({
    queryKey: ["wf-channels"],
    queryFn: () => wfApi.notifications.channels.list(),
  });
  const channels = useMemo<ChannelPublic[]>(() => q.data || [], [q.data]);

  const openId = selectedId && channels.some((c) => c.channel_id === selectedId)
    ? selectedId
    : channels[0]?.channel_id;
  const selected = channels.find((c) => c.channel_id === openId) || null;
  const enabledCount = channels.filter((c) => c.is_enabled).length;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wf-channels"] });

  const save = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: CreateChannelRequest }) =>
      id ? wfApi.notifications.channels.update(id, body) : wfApi.notifications.channels.create(body),
    onSuccess: (saved) => {
      toast.success(editing ? "Channel saved" : "Channel created");
      setEditing(undefined);
      setSelectedId(saved.channel_id);
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => wfApi.notifications.channels.remove(id),
    onSuccess: () => {
      toast.success("Channel deleted");
      setSelectedId(null);
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_enabled }: { id: string; is_enabled: boolean }) =>
      wfApi.notifications.channels.update(id, { is_enabled }),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  return (
    <ConsoleGrid>
      <ConsolePanel>
        <PanelHeader
          icon="heroicons-outline:paper-airplane"
          title="Channels"
          count={channels.length}
          actions={
            <>
              <PanelCounts
                items={[
                  { tone: "good", value: enabledCount, label: "enabled" },
                  { tone: "idle", value: channels.length - enabledCount, label: "disabled" },
                ]}
              />
              <IconButton icon="heroicons:plus" title="New channel" onClick={() => setEditing(null)} />
            </>
          }
        />
        <PanelList
          loading={q.isLoading}
          // "No channels configured" and "we could not read them" are opposite
          // claims, and the second one still means notifications are going out.
          error={q.isError ? apiError(q.error, "Couldn't load channels") : undefined}
          empty={channels.length === 0}
          emptyText="No channels yet. Use ＋ above to add one — until then, notifications fall back to the service's own SMTP environment."
        >
          {channels.map((c) => {
            const meta = typeMeta(c.channel_type);
            return (
              <button
                key={c.channel_id}
                type="button"
                onClick={() => setSelectedId(c.channel_id)}
                className={`block w-full rounded-[10px] border px-3 py-2.5 text-left transition ${
                  openId === c.channel_id
                    ? "border-nb-blue bg-[rgba(96,165,250,.1)]"
                    : "border-nb-line bg-[rgba(10,18,40,.5)] hover:border-nb-blue/60"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      c.is_enabled ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-faint"
                    }`}
                  />
                  <Icon icon={meta?.icon || "heroicons-outline:paper-airplane"} className="shrink-0 text-sm text-nb-blueb" />
                  <span className="truncate text-[13px] font-semibold text-nb-ink">{c.name}</span>
                  {c.is_default && (
                    <span className="ml-auto shrink-0 rounded-full border border-nb-line px-1.5 text-[9.5px] uppercase text-nb-faint">
                      default
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate pl-4 text-[11px] text-nb-faint">{meta?.label || c.channel_type}</p>
              </button>
            );
          })}
        </PanelList>
      </ConsolePanel>

      <ConsolePanel>
        {selected ? (
          <ChannelDetail
            key={selected.channel_id}
            channel={selected}
            onEdit={() => setEditing(selected)}
            onToggle={(v) => toggle.mutate({ id: selected.channel_id, is_enabled: v })}
            onDelete={() =>
              setConfirm({
                title: "Delete channel",
                message: `Delete “${selected.name}”? Notifications on this channel fall back to the service environment, or fail.`,
                confirmLabel: "Delete",
                danger: true,
                onConfirm: () => {
                  remove.mutate(selected.channel_id);
                  setConfirm(null);
                },
              })
            }
          />
        ) : (
          <EmptyPane
            icon="heroicons-outline:paper-airplane"
            title="No channel selected"
            subtitle="Pick one from the list, or use ＋ above to add one."
          />
        )}
      </ConsolePanel>

      <ChannelModal
        open={editing !== undefined}
        channel={editing ?? null}
        saving={save.isPending}
        onClose={() => setEditing(undefined)}
        onSave={(body) => save.mutate({ id: editing?.channel_id, body })}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </ConsoleGrid>
  );
}

function ChannelDetail({
  channel,
  onEdit,
  onToggle,
  onDelete,
}: {
  channel: ChannelPublic;
  onEdit: () => void;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
}) {
  const meta = typeMeta(channel.channel_type);
  const fields = FIELDS[channel.channel_type] || [];
  const cfg = channel.config || {};

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nb-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-nb-blue/40 bg-[rgba(96,165,250,.12)] text-nb-blueb">
            <Icon icon={meta?.icon || "heroicons-outline:paper-airplane"} className="text-base" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-nb-ink">{channel.name}</h2>
            <p className="truncate text-[11px] text-nb-faint">{meta?.label || channel.channel_type}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle checked={channel.is_enabled} onChange={onToggle} label="Enabled" />
          <Button variant="secondary" icon="heroicons-outline:pencil-square" className="!px-2.5 !py-1.5 !text-xs" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="danger" icon="heroicons-outline:trash" className="!px-2 !py-1.5 !text-xs" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {fields.map((f) => {
            const raw = cfg[f.key];
            const value = raw === undefined || raw === null || raw === "" ? "—" : configText(raw);
            return (
              <div key={f.key} className="rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{f.label}</p>
                <p className="mt-0.5 truncate font-mono text-[12.5px] text-nb-ink">{value}</p>
              </div>
            );
          })}
        </div>
        {/* A stored secret reads as its redaction marker, never as the value. */}
        {fields.some((f) => f.secret) && (
          <p className="mt-3 flex items-start gap-1.5 text-[11px] text-nb-faint">
            <Icon icon="heroicons-outline:lock-closed" className="mt-0.5 shrink-0 text-xs" />
            Credentials are encrypted at rest and never returned. Re-enter one only to change it.
          </p>
        )}
      </div>
    </>
  );
}

function ChannelModal({
  open,
  channel,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  channel: ChannelPublic | null;
  saving: boolean;
  onClose: () => void;
  onSave: (body: CreateChannelRequest) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("email");
  const [cfg, setCfg] = useState<Record<string, string>>({});
  // The alias keys this form has no row for and cannot hold as text — a
  // webhook's `headers` object, for instance. They are seeded aside and merged
  // back on save; stringifying them into `cfg` would write "[object Object]"
  // over a working connector's config the first time anyone opened this modal.
  const [passthrough, setPassthrough] = useState<Record<string, unknown>>({});
  const [isDefault, setIsDefault] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seed from the row being edited, once per open. Derived rather than synced in
  // an effect: an effect re-seeding on every render would fight the typing.
  const seedKey = open ? channel?.channel_id || "new" : null;
  if (seedKey !== seeded) {
    setSeeded(seedKey);
    setName(channel?.name || "");
    setType(channel?.channel_type || "email");
    setIsDefault(!!channel?.is_default);
    const entries = Object.entries(channel?.config || {});
    setCfg(Object.fromEntries(entries.filter(([, v]) => isEditable(v)).map(([k, v]) => [k, v == null ? "" : String(v)])));
    setPassthrough(Object.fromEntries(entries.filter(([, v]) => !isEditable(v))));
  }

  const fields = FIELDS[type] || [];
  const nameError = !name.trim() ? "A name is required" : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title={channel ? "Edit channel" : "New channel"}
      subtitle="Where incident notifications are delivered."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            disabled={saving || !name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                channel_type: type,
                is_default: isDefault,
                // Empty strings are dropped: an untouched optional field must not
                // be stored as "", which a connector would read as configured.
                config: {
                  ...passthrough,
                  ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== "")),
                },
              })
            }
          >
            {saving ? "Saving…" : channel ? "Save changes" : "Create channel"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ops mailbox"
            error={name || !open ? undefined : nameError}
          />
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={CHANNEL_TYPES.map((c) => ({ value: c.value, label: c.label }))}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <Input
              key={f.key}
              label={f.label}
              value={cfg[f.key] ?? ""}
              onChange={(e) => setCfg((c) => ({ ...c, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              // A stored secret arrives redacted; submitting it unchanged keeps
              // the stored value, so the field is safe to leave as it came.
              hint={f.secret ? "Leave as-is to keep the stored credential" : undefined}
            />
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-nb-soft">
          <Toggle checked={isDefault} onChange={setIsDefault} label="Default for this type" />
          Default for this type
        </label>
      </div>
    </Modal>
  );
}
