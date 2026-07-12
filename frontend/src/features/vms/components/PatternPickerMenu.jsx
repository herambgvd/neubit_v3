"use client";

// PatternPickerMenu — the wall-toolbar dropdown that lists server-persisted
// Patterns (named rotating sequences of camera groups). Selecting one starts
// rotation on the wall. Sits next to the localStorage "Saved" layouts menu; the
// two are complementary — Saved = a single static grid, Patterns = a rotation.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import Link from "next/link";

export default function PatternPickerMenu({ patterns = [], loading, activeId, onPlay, onStop, onCreate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = patterns.find((p) => p.id === activeId) || null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Patterns"
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
          active
            ? "border-blue-500 bg-blue-500/10 text-blue-400"
            : "border-card-border bg-card text-foreground hover:bg-hover"
        }`}
      >
        <Icon icon="heroicons-outline:squares-2x2" className="text-sm" />
        {active ? <span className="max-w-[8rem] truncate">{active.name}</span> : "Patterns"}
        {active ? (
          <Icon icon="svg-spinners:180-ring" className="text-xs" />
        ) : (
          patterns.length > 0 && (
            <span className="rounded-full bg-hover px-1.5 text-[9px] font-semibold text-muted">{patterns.length}</span>
          )
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-card-border bg-card py-1 shadow-2xl">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Patterns</span>
            <div className="flex items-center gap-1">
              {active && (
                <button
                  type="button"
                  onClick={() => {
                    onStop?.();
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-red-500 transition hover:bg-red-500/10"
                >
                  <Icon icon="heroicons-mini:stop" className="text-xs" />
                  Stop
                </button>
              )}
              {onCreate && (
                <button
                  type="button"
                  onClick={() => {
                    onCreate();
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-blue-400 transition hover:bg-blue-500/10"
                >
                  <Icon icon="heroicons-mini:plus" className="text-xs" />
                  New
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="px-3 py-3 text-center text-xs text-muted">
              <Icon icon="svg-spinners:180-ring" className="mx-auto text-base" />
            </div>
          ) : patterns.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted">
              No patterns yet.{" "}
              {onCreate ? (
                <button
                  type="button"
                  onClick={() => {
                    onCreate();
                    setOpen(false);
                  }}
                  className="text-blue-400 hover:underline"
                >
                  Create one here
                </button>
              ) : (
                <>
                  <Link href="/config/patterns" className="text-blue-400 hover:underline">
                    Create one
                  </Link>{" "}
                  in Config → Patterns.
                </>
              )}
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-card-border pt-1">
              {patterns.map((p) => {
                const isActive = p.id === activeId;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onPlay?.(p);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-hover ${
                        isActive ? "bg-blue-500/10" : ""
                      }`}
                    >
                      <Icon
                        icon={isActive ? "heroicons-solid:signal" : "heroicons-solid:play"}
                        className={`shrink-0 text-sm ${isActive ? "text-blue-400" : "text-muted"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-foreground">{p.name}</span>
                        <span className="block text-[10px] text-muted">
                          {(p.camera_group_ids || []).length} groups · {p.seconds || 0}s dwell
                        </span>
                      </span>
                      {p.is_active === false && (
                        <span className="shrink-0 rounded-full bg-hover px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted">
                          Off
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-card-border px-3 py-1.5">
            <Link
              href="/config/patterns"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted transition hover:text-foreground"
            >
              <Icon icon="heroicons-outline:cog-6-tooth" className="text-xs" />
              Manage patterns
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
