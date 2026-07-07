"use client";

// Floor-plan editor toolbar — ported from neubit_v2, rethemed to neubit_v3 tokens.
// The "Devices" mode button is DISABLED (deferred — no devices backend in neubit_v3).
// Re-enable by removing `disabled` on the Devices mode below in the devices phase.
import { Icon } from "@iconify/react";

import { EDITOR_MODES } from "@/components/floor-builder/constants";

const MODES = [
  { mode: EDITOR_MODES.VIEW, label: "View" },
  { mode: EDITOR_MODES.ZONE_DRAW, label: "Zones" },
  // Deferred: device placement has no backend yet in neubit_v3.
  { mode: EDITOR_MODES.DEVICE_PLACE, label: "Devices", disabled: true },
];

export function FloorPlanToolbar({
  editorMode,
  onModeChange,
  zoneCount = 0,
  deviceCount = 0,
  unsavedChanges = false,
  lastSavedAt = null,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSave,
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-card-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-full border border-card-border bg-hover p-1 text-sm font-medium">
          {MODES.map((m) => {
            const active = m.mode === editorMode;
            return (
              <button
                key={m.mode}
                type="button"
                disabled={m.disabled}
                title={m.disabled ? "Device placement — coming soon" : undefined}
                onClick={() => !m.disabled && onModeChange?.(m.mode)}
                className={`rounded-full px-4 py-1.5 transition ${
                  active
                    ? "bg-foreground text-background shadow"
                    : m.disabled
                      ? "text-muted/40 cursor-not-allowed"
                      : "text-muted hover:text-foreground"
                }`}
              >
                {m.label}
                {m.disabled && (
                  <span className="ml-1.5 rounded bg-hover px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted/70">
                    Soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-5">
        <div className="flex items-center gap-4 text-sm">
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted">Zones</div>
            <div className="text-base font-semibold text-foreground">{zoneCount}</div>
          </div>
          <div className="h-8 w-px bg-card-border" />
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted">Devices</div>
            <div className="text-base font-semibold text-muted/50">{deviceCount}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-foreground hover:bg-hover disabled:opacity-40 disabled:pointer-events-none"
          >
            <Icon icon="heroicons-outline:arrow-uturn-left" className="text-base" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-foreground hover:bg-hover disabled:opacity-40 disabled:pointer-events-none"
          >
            <Icon icon="heroicons-outline:arrow-uturn-right" className="text-base" />
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!unsavedChanges}
            title={
              lastSavedAt ? `Last saved ${new Date(lastSavedAt).toLocaleTimeString()}` : "Save changes"
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
          >
            <Icon icon="heroicons-outline:bookmark-square" className="text-base" />
            {unsavedChanges ? "Save" : "Saved"}
          </button>
        </div>
      </div>
    </div>
  );
}
