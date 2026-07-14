"use client";

// The recordings list table — one row per Recording with camera, time range,
// duration, size, a trigger badge, an integrity dot, a lock state, and row
// actions (lock/unlock, verify, play, export). Presentational: the parent owns
// data + wires the action callbacks. Play jumps to the Playback surface at the
// recording's time; Export opens the clip-export dialog for its range (P4-C).
import { Icon } from "@iconify/react";

import { fmtBytes, fmtDuration, fmtDateTime } from "@/lib/format";
import { INTEGRITY_PRESETS, TRIGGER_PRESETS } from "../constants";

function TriggerBadge({ trigger }) {
  const p = TRIGGER_PRESETS[trigger] || { label: trigger || "—", cls: "bg-hover text-muted border-card-border", icon: "heroicons-outline:film" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${p.cls}`}>
      <Icon icon={p.icon} className="text-xs" />
      {p.label}
    </span>
  );
}

function IntegrityDot({ status }) {
  const p = INTEGRITY_PRESETS[status] || INTEGRITY_PRESETS.pending;
  return (
    <span className="inline-flex items-center gap-1.5" title={p.label}>
      <span className={`inline-block h-2 w-2 rounded-full ${p.dot}`} />
      <span className={`text-[11px] ${p.text}`}>{p.label}</span>
    </span>
  );
}

// "Protected" badge — the recording is under a lock / evidence hold, so the
// retention & tiering workers will never auto-delete it (G3).
function ProtectedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500"
      title="Protected from retention & tiering deletion"
    >
      <Icon icon="heroicons-solid:shield-check" className="text-xs" />
      Protected
    </span>
  );
}

function IconBtn({ icon, title, onClick, disabled, danger, className = "" }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-card-border transition disabled:opacity-40 disabled:pointer-events-none ${
        danger ? "text-red-500 hover:bg-red-500/10" : "text-muted hover:bg-hover hover:text-foreground"
      } ${className}`}
    >
      <Icon icon={icon} className="text-base" />
    </button>
  );
}

export default function RecordingsTable({
  recordings = [],
  cameraNames = {},
  showCamera = true,
  onLock,
  onUnlock,
  onVerify,
  onPlay,
  onExport,
  pendingId,
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border bg-hover/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
            {showCamera && <th className="px-4 py-2.5">Camera</th>}
            <th className="px-4 py-2.5">Start</th>
            <th className="px-4 py-2.5">End</th>
            <th className="px-4 py-2.5 text-right">Duration</th>
            <th className="px-4 py-2.5 text-right">Size</th>
            <th className="px-4 py-2.5">Trigger</th>
            <th className="px-4 py-2.5">Integrity</th>
            <th className="px-4 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {recordings.map((r) => {
            const busy = pendingId === r.id;
            const dur =
              r.duration ??
              (r.start_time && r.end_time
                ? (new Date(r.end_time) - new Date(r.start_time)) / 1000
                : null);
            return (
              <tr key={r.id} className="border-b border-card-border/60 last:border-0 transition hover:bg-hover/50">
                {showCamera && (
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 text-foreground">
                      <Icon icon="heroicons-outline:video-camera" className="text-base text-muted" />
                      <span className="font-medium">
                        {cameraNames[r.camera_id] || String(r.camera_id).slice(0, 8)}
                      </span>
                      {r.profile && (
                        <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] uppercase text-muted">
                          {r.profile}
                        </span>
                      )}
                    </div>
                  </td>
                )}
                <td className="px-4 py-3 text-muted">{fmtDateTime(r.start_time)}</td>
                <td className="px-4 py-3 text-muted">{r.end_time ? fmtDateTime(r.end_time) : "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted">{fmtDuration(dur)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Icon icon="heroicons-outline:circle-stack" className="text-xs" />
                    {fmtBytes(r.file_size)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <TriggerBadge trigger={r.trigger_type} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <IntegrityDot status={r.integrity_status} />
                    {r.locked && <ProtectedBadge />}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <IconBtn
                      icon="heroicons-outline:play"
                      title="Play in Playback"
                      onClick={() => onPlay?.(r)}
                    />
                    <IconBtn
                      icon="heroicons-outline:scissors"
                      title="Export clip"
                      onClick={() => onExport?.(r)}
                    />
                    <IconBtn
                      icon="heroicons-outline:shield-check"
                      title="Verify integrity"
                      disabled={busy}
                      onClick={() => onVerify?.(r)}
                    />
                    {r.locked ? (
                      <IconBtn
                        icon="heroicons-outline:lock-closed"
                        title="Unlock (allow retention/tiering)"
                        disabled={busy}
                        onClick={() => onUnlock?.(r)}
                        className="!text-amber-500"
                      />
                    ) : (
                      <IconBtn
                        icon="heroicons-outline:lock-open"
                        title="Lock (protect from deletion)"
                        disabled={busy}
                        onClick={() => onLock?.(r)}
                      />
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
