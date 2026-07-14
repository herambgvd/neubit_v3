"use client";

// WallCellPicker — the command-palette-style camera picker for filling an empty
// wall cell when the rail is collapsed / you're on a projector. Thin wrapper over
// the VMS CameraQuickPicker so the console and /streaming share one picker UX.
import CameraQuickPicker from "@/features/vms/components/CameraQuickPicker";

export default function WallCellPicker({ open, cameras, mountedIds, onPick, onClose }) {
  return (
    <CameraQuickPicker
      open={open}
      cameras={cameras}
      mountedIds={mountedIds}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
