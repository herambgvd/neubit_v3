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
        className="w-full max-w-md overflow-hidden rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.95)] shadow-2xl backdrop-blur-xs"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[rgba(160,150,245,.22)] px-3">
          <Icon icon="heroicons-outline:magnifying-glass" className="text-base text-[#7e93bf]" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Add camera to tile ${tileIndex != null ? tileIndex + 1 : ""}…`}
            className="h-11 flex-1 bg-transparent text-sm text-[#f2f6ff] placeholder:text-[#7e93bf] outline-hidden"
          />
          <kbd className="rounded-sm border border-[rgba(150,180,245,.22)] px-1.5 py-0.5 font-mono text-[10px] text-[#7e93bf]">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-[#7e93bf]">No cameras match.</li>
          ) : (
            filtered.map((c) => {
              const onWall = mountedIds?.has(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick?.(c.id)}
                    className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition hover:bg-[rgba(150,180,245,.07)]"
                  >
                    <StatusDot status={c.status} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-[#f2f6ff]">{c.name}</span>
                      {c.site_name && <span className="truncate text-[11px] text-[#7e93bf]">{c.site_name}</span>}
                    </span>
                    {onWall && (
                      <Icon icon="heroicons-solid:tv" className="shrink-0 text-sm text-[#22d3ee]" title="Already on wall" />
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
