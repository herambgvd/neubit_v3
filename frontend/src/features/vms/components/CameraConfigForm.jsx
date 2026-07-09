"use client";

// The tabbed camera configuration body — shared by the onboard modal (create) and
// the detail/edit modal (update). Presentational + controlled: the parent owns the
// flat `form` object and passes `set(patch)`; this renders the active tab's fields.
//
// Tabs (constants.CONFIG_TABS): Live · Recording · ONVIF · Imaging · I/O · Advanced.
// Live/Recording/ONVIF drive real CameraCreate fields; Imaging/IO/Advanced are
// P1-informational (the ONVIF-backed imaging/io/motion/privacy config endpoints are
// wired in the detail view once a camera exists — see CameraConfigTabs there).
import { Icon } from "@iconify/react";

import { Field } from "@/components/common";
import { Button, Toggle } from "@/components/ui/kit";
import { CAMERA_BRANDS, CONNECTION_TYPES, RECORDING_MODES } from "../constants";
import RecordingScheduleGrid from "./RecordingScheduleGrid";

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="text-[11px] text-muted">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function InfoNote({ children }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-card-border bg-hover px-3 py-2.5 text-[11px] text-muted">
      <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
      <span>{children}</span>
    </div>
  );
}

export default function CameraConfigForm({
  tab,
  form,
  set,
  errors = {},
  sites = [],
  floors = [],
  zones = [],
  isEdit = false,
  onManualStart,
  onManualStop,
  manualPending = false,
}) {
  if (tab === "live") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Camera name"
            required
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Lobby North"
            error={errors.name}
          />
          <Field
            as="select"
            label="Brand"
            value={form.brand}
            onChange={(e) => set({ brand: e.target.value })}
            options={CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            as="select"
            label="Connection type"
            value={form.connection_type}
            onChange={(e) => set({ connection_type: e.target.value })}
            options={CONNECTION_TYPES}
          />
          <Field
            label="IP address"
            value={form.ip}
            onChange={(e) => set({ ip: e.target.value })}
            placeholder="192.168.1.64"
            error={errors.ip}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field
            label="HTTP port"
            type="number"
            value={form.port}
            onChange={(e) => set({ port: e.target.value })}
            placeholder="80"
          />
          <Field
            label="RTSP port"
            type="number"
            value={form.rtsp_port}
            onChange={(e) => set({ rtsp_port: e.target.value })}
            placeholder="554"
          />
          <div className="flex flex-col justify-end pb-0.5">
            <ToggleRow
              label="Enabled"
              checked={!!form.is_enabled}
              onChange={(v) => set({ is_enabled: v })}
            />
          </div>
        </div>

        {/* Placement — site / floor / zone (feed the Events Map + floor-builder). */}
        <div className="grid grid-cols-3 gap-3">
          <Field
            as="select"
            label="Site"
            value={form.site_id}
            onChange={(e) => set({ site_id: e.target.value, floor_id: "", zone_id: "" })}
            options={[{ value: "", label: "— Unassigned —" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
          />
          <Field
            as="select"
            label="Floor"
            value={form.floor_id}
            onChange={(e) => set({ floor_id: e.target.value, zone_id: "" })}
            options={[
              { value: "", label: "— None —" },
              ...floors
                .filter((f) => !form.site_id || f.site_id === form.site_id)
                .map((f) => ({ value: f.floor_id || f.id, label: f.name })),
            ]}
          />
          <Field
            as="select"
            label="Zone"
            value={form.zone_id}
            onChange={(e) => set({ zone_id: e.target.value })}
            options={[
              { value: "", label: "— None —" },
              ...zones
                .filter((z) => !form.floor_id || z.floor_id === form.floor_id)
                .map((z) => ({ value: z.zone_id || z.id, label: z.name })),
            ]}
          />
        </div>

        <InfoNote>
          Live video and playback arrive in P2 — for now a camera streams once the Go
          media-plane is online. The placement fields above already publish the camera
          to the Events Map.
        </InfoNote>
      </div>
    );
  }

  if (tab === "recording") {
    return (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Recording mode</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {RECORDING_MODES.map((m) => {
              const active = form.recording_mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => set({ recording_mode: m.value })}
                  className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-xs transition ${
                    active ? "border-foreground bg-hover text-foreground" : "border-card-border text-muted hover:bg-hover"
                  }`}
                >
                  <Icon icon={m.icon} className="text-base" />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Weekly schedule painter — only relevant when mode = schedule. */}
        {form.recording_mode === "schedule" && (
          <div className="rounded-lg border border-card-border bg-card p-3">
            <RecordingScheduleGrid
              value={form.recording_schedule}
              onChange={(sched) => set({ recording_schedule: sched })}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Retention (days)"
            type="number"
            value={form.retention_days}
            onChange={(e) => set({ retention_days: e.target.value })}
            placeholder="30"
          />
          <Field
            label="Recording FPS"
            type="number"
            value={form.recording_fps}
            onChange={(e) => set({ recording_fps: e.target.value })}
            placeholder="Camera default"
            hint="Blank = use the camera's native FPS"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Pre-buffer (s)"
            type="number"
            value={form.pre_buffer_seconds}
            onChange={(e) => set({ pre_buffer_seconds: e.target.value })}
            placeholder="5"
          />
          <Field
            label="Post-buffer (s)"
            type="number"
            value={form.post_buffer_seconds}
            onChange={(e) => set({ post_buffer_seconds: e.target.value })}
            placeholder="5"
          />
        </div>

        <ToggleRow
          label="Record substream"
          hint="Store the lower-resolution sub-stream alongside the main."
          checked={!!form.record_substream}
          onChange={(v) => set({ record_substream: v })}
        />
        <ToggleRow
          label="ANR (edge fill)"
          hint="Backfill gaps from on-camera storage after a network drop."
          checked={!!form.anr_enabled}
          onChange={(v) => set({ anr_enabled: v })}
        />

        {/* Manual recording controls — only once the camera exists (edit view). */}
        {isEdit && (onManualStart || onManualStop) && (
          <div className="flex items-center justify-between rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-foreground">Manual recording</p>
              <p className="text-[11px] text-muted">Start or stop recording on this camera right now.</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="success"
                icon="heroicons-outline:play"
                className="!px-2.5 !py-1.5 !text-xs"
                disabled={manualPending || !onManualStart}
                onClick={() => onManualStart?.()}
              >
                Start
              </Button>
              <Button
                variant="danger"
                icon="heroicons-outline:stop"
                className="!px-2.5 !py-1.5 !text-xs"
                disabled={manualPending || !onManualStop}
                onClick={() => onManualStop?.()}
              >
                Stop
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (tab === "onvif") {
    return (
      <div className="space-y-4">
        <InfoNote>
          ONVIF credentials are used to probe capabilities, pull stream URIs and drive
          PTZ/imaging. The password is write-only — it is never returned once saved.
        </InfoNote>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="ONVIF host"
            value={form.onvif_host}
            onChange={(e) => set({ onvif_host: e.target.value })}
            placeholder="Defaults to the IP above"
          />
          <Field
            label="ONVIF port"
            type="number"
            value={form.onvif_port}
            onChange={(e) => set({ onvif_port: e.target.value })}
            placeholder="80"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Username"
            value={form.onvif_user}
            onChange={(e) => set({ onvif_user: e.target.value })}
            placeholder="admin"
          />
          <Field
            label="Password"
            type="password"
            value={form.onvif_password}
            onChange={(e) => set({ onvif_password: e.target.value })}
            placeholder={isEdit && form.has_password ? "•••••• (unchanged)" : "••••••••"}
            hint={isEdit ? "Leave blank to keep the stored password." : undefined}
          />
        </div>
        <Field
          label="Profile token"
          value={form.onvif_profile_token}
          onChange={(e) => set({ onvif_profile_token: e.target.value })}
          placeholder="Optional — pin a specific media profile"
        />
      </div>
    );
  }

  if (tab === "imaging") {
    return (
      <div className="space-y-4">
        <InfoNote>
          {isEdit
            ? "Imaging settings (brightness, contrast, WDR, day/night) are pushed to the camera over ONVIF."
            : "Imaging is configured after the camera is onboarded — the ONVIF imaging service is queried live once it's reachable."}
        </InfoNote>
        <div className="grid grid-cols-2 gap-3 opacity-60">
          <Field label="Brightness" type="number" disabled placeholder="—" />
          <Field label="Contrast" type="number" disabled placeholder="—" />
          <Field label="Saturation" type="number" disabled placeholder="—" />
          <Field label="Sharpness" type="number" disabled placeholder="—" />
        </div>
        <ToggleRow label="Wide Dynamic Range (WDR)" checked={false} onChange={() => {}} />
      </div>
    );
  }

  if (tab === "io") {
    return (
      <div className="space-y-4">
        <InfoNote>
          Digital inputs/outputs (relays, alarm contacts) are enumerated from the camera
          over ONVIF after onboarding. Trigger rules bind in Workflow.
        </InfoNote>
        <div className="rounded-lg border border-dashed border-card-border px-4 py-8 text-center text-xs text-muted">
          No I/O ports enumerated yet.
        </div>
      </div>
    );
  }

  // advanced
  return (
    <div className="space-y-4">
      <ToggleRow
        label="PTZ capable"
        hint="Mark this camera as pan/tilt/zoom — enables PTZ controls in Live."
        checked={!!form.ptz_capable}
        onChange={(v) => set({ ptz_capable: v })}
      />
      <InfoNote>
        Privacy masks, motion zones, POS overlay and dewarp are drawn on the live view in
        P2. They persist against this camera's advanced config.
      </InfoNote>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        {["Privacy masks", "Motion zones", "POS overlay", "Dewarp"].map((f) => (
          <div key={f} className="flex items-center gap-2 rounded-lg border border-card-border px-3 py-2 text-muted">
            <Icon icon="heroicons-outline:clock" className="text-sm" /> {f} — P2
          </div>
        ))}
      </div>
    </div>
  );
}
