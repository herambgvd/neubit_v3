"use client";

// CameraQuickPicker — a centered command-palette-style popover for filling an
// empty wall tile without dragging from the rail (great when the rail is
// collapsed / on a projector). Opened by clicking an empty tile; searches the
// estate and assigns the picked camera to the target tile.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

import { StatusDot } from "./StatusBadge";

export default function CameraQuickPicker({ open, cameras = [], mountedIds, tileIndex, onPick, onClose }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ("");
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cameras;
    return cameras.filter(
      (c) => c.name?.toLowerCase().includes(needle) || c.site_name?.toLowerCase?.().includes(needle),
    );
  }, [cameras, q]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-card-border bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-card-border px-3">
          <Icon icon="heroicons-outline:magnifying-glass" className="text-base text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Add camera to tile ${tileIndex != null ? tileIndex + 1 : ""}…`}
            className="h-11 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted outline-none"
          />
          <kbd className="rounded border border-card-border px-1.5 py-0.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted">No cameras match.</li>
          ) : (
            filtered.map((c) => {
              const onWall = mountedIds?.has(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick?.(c.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-hover"
                  >
                    <StatusDot status={c.status} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
                      {c.site_name && <span className="truncate text-[11px] text-muted">{c.site_name}</span>}
                    </span>
                    {onWall && (
                      <Icon icon="heroicons-solid:tv" className="shrink-0 text-sm text-blue-500" title="Already on wall" />
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
