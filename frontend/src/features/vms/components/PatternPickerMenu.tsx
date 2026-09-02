"use client";

// PatternPickerMenu — the wall-toolbar dropdown that lists server-persisted
// Patterns (named rotating sequences of camera groups). Selecting one starts
// rotation on the wall. Sits next to the localStorage "Saved" layouts menu; the
// two are complementary — Saved = a single static grid, Patterns = a rotation.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import Link from "next/link";

export default function PatternPickerMenu({
  patterns = [],
  loading,
  activeId,
  // Which stop the running rotation is on, 1-based, and how many there are.
  // Shown instead of a spinner: a rotation that is WORKING must not look like a
  // request that never came back.
  stop,
  total,
  paused = false,
  onPlay,
  onStop,
  onCreate,
}: any) {
  const [open, setOpen] = useState(false);
  const ref = useRef<any>(null);

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
        className={`inline-flex h-8 items-center gap-1.5 rounded-[8px] border px-2.5 text-xs font-medium transition ${
          active
            ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
            : "border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] text-[#f2f6ff] hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
        }`}
      >
        <Icon icon="heroicons-outline:squares-2x2" className="text-sm" />
        {active ? <span className="max-w-[8rem] truncate">{active.name}</span> : "Patterns"}
        {active ? (
          // Running state: which stop we are on, and paused vs rotating. The
          // spinner that used to live here is the app's LOADING glyph — the same
          // one this menu shows a few lines below while patterns are fetching —
          // so a healthy rotation was indistinguishable from a stuck request.
          <span className="flex items-center gap-1">
            {total > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-[#67e8f9]/80">
                {stop}/{total}
              </span>
            )}
            {/* Deliberately NOT animated. The counter above ticks on every dwell,
                which is the honest liveness signal; a spinning glyph next to it
                would walk straight back into "this looks like it is loading". */}
            <Icon icon={paused ? "heroicons-outline:pause" : "heroicons-outline:play"} className="text-xs" />
          </span>
        ) : (
          patterns.length > 0 && (
            <span className="rounded-full bg-[rgba(150,180,245,.1)] px-1.5 text-[9px] font-semibold text-[#aec2e8]">{patterns.length}</span>
          )
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.93)] py-1 shadow-2xl backdrop-blur-xs">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Patterns</span>
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
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#67e8f9] transition hover:bg-[rgba(34,211,238,.12)]"
                >
                  <Icon icon="heroicons-mini:plus" className="text-xs" />
                  New
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="px-3 py-3 text-center text-xs text-[#aec2e8]">
              <Icon icon="svg-spinners:180-ring" className="mx-auto text-base" />
            </div>
          ) : patterns.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[#aec2e8]">
              No patterns yet.{" "}
              {onCreate ? (
                <button
                  type="button"
                  onClick={() => {
                    onCreate();
                    setOpen(false);
                  }}
                  className="text-[#67e8f9] hover:underline"
                >
                  Create one here
                </button>
              ) : (
                <>
                  <Link href="/config/patterns" className="text-[#67e8f9] hover:underline">
                    Create one
                  </Link>{" "}
                  in Config → Patterns.
                </>
              )}
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-[rgba(160,150,245,.22)] pt-1">
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
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[rgba(150,180,245,.07)] ${
                        isActive ? "bg-[rgba(34,211,238,.1)]" : ""
                      }`}
                    >
                      <Icon
                        icon={isActive ? "heroicons-solid:signal" : "heroicons-solid:play"}
                        className={`shrink-0 text-sm ${isActive ? "text-[#67e8f9]" : "text-[#7e93bf]"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-[#f2f6ff]">{p.name}</span>
                        <span className="block font-mono text-[10px] text-[#7e93bf]">
                          {(p.camera_group_ids || []).length} groups · {p.seconds || 0}s dwell
                        </span>
                      </span>
                      {p.is_active === false && (
                        <span className="shrink-0 rounded-full bg-[rgba(150,180,245,.1)] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[#7e93bf]">
                          Off
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-[rgba(160,150,245,.22)] px-3 py-1.5">
            <Link
              href="/config/patterns"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7e93bf] transition hover:text-[#67e8f9]"
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
