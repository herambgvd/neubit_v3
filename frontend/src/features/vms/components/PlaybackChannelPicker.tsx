"use client";

// The Playback rail's CHANNEL PICKER — recorder › camera, searchable.
//
// It used to be two tabs: "Recorders" and "VMS storage". The second one can never
// hold anything. Single ownership is the architecture (see Cameras.tsx): the
// recorder owns every camera and writes every frame, and this platform onboards
// none and records none — so a tab pointing at its own pooled storage was an
// operator's choice between the cameras and an empty list. A deployment that DOES
// still carry VMS-owned rows sees them as one more branch here, named for what
// they are, rather than as a permanent second tab.
//
// The shape is a TREE because a recorder holds many cameras and this rail is
// 25% of the screen: a flat list of every channel on every recorder is unusable
// at the moment an operator needs it. Each recorder is a collapsible branch with
// its own counts; searching flattens the tree to matches and force-expands, which
// is the same behaviour the Sites and Recorded pickers already had.
//
// Selection is capped (2×2 grid), and a row that would exceed the cap is shown
// disabled rather than hidden — an operator must be able to see the channel they
// cannot add yet, and why.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

export interface PickerRow {
  /** Tile key — unique across recorders. */
  key: string;
  name: string;
  /** online / offline / unknown, as the owning recorder reports it. */
  status?: string | null;
}

export interface PickerGroup {
  key: string;
  /** The recorder's name, or "VMS storage" for this platform's own rows. */
  label: string;
  icon: string;
  rows: PickerRow[];
}

export interface PlaybackChannelPickerProps {
  groups: PickerGroup[];
  checkedKeys: Set<string>;
  onToggle: (key: string) => void;
  max: number;
  loading?: boolean;
  error?: string | null;
}

const isOnline = (status?: string | null) => String(status || "").toLowerCase() === "online";

export default function PlaybackChannelPicker({
  groups,
  checkedKeys,
  onToggle,
  max,
  loading,
  error,
}: PlaybackChannelPickerProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const term = search.trim().toLowerCase();
  const searching = term.length > 0;

  // Matching is on the camera AND its recorder's name: "recorder-a" finds every
  // channel on that recorder, which is how an operator narrows first.
  const filtered = useMemo(() => {
    if (!searching) return groups;
    return groups
      .map((g) => ({
        ...g,
        rows: g.label.toLowerCase().includes(term)
          ? g.rows
          : g.rows.filter((r) => r.name.toLowerCase().includes(term)),
      }))
      .filter((g) => g.rows.length > 0);
  }, [groups, term, searching]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const shown = filtered.reduce((n, g) => n + g.rows.length, 0);
  const atCap = checkedKeys.size >= max;

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-2">
      <label className="relative block">
        <Icon
          icon="heroicons-outline:magnifying-glass"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#9db0d8]"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search channels or recorders…"
          aria-label="Search channels"
          className="h-8 w-full rounded-lg border border-[rgba(150,180,245,.28)] bg-transparent pl-8 pr-7 text-[13px] text-[#f2f6ff] placeholder:text-[#7e93bf] outline-hidden focus:border-muted"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setSearch("")}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[#9db0d8] transition hover:text-[#f2f6ff]"
          >
            <Icon icon="heroicons-mini:x-mark" className="text-sm" />
          </button>
        )}
      </label>

      {searching && (
        // The count is the point of searching a rail this size: it says whether the
        // channel is missing or merely further down.
        <p className="px-1 text-[10.5px] text-[#9db0d8]">
          {shown} of {total} channels match
        </p>
      )}

      {loading ? (
        <p className="px-2 py-6 text-center text-xs text-[#9db0d8]">Loading channels…</p>
      ) : error ? (
        // A recorder that did not answer must never read as an estate with no
        // cameras — one sends the operator to onboarding, the other to the recorder.
        <p className="px-2 py-6 text-center text-xs text-red-300">{error}</p>
      ) : total === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-[#9db0d8]">
          No channels. Cameras are owned by recorders — enrol one under Configurations →
          Recorders.
        </p>
      ) : shown === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-[#9db0d8]">
          No channel matches “{search.trim()}”.
        </p>
      ) : (
        <div className="space-y-1">
          {filtered.map((g) => {
            const open = searching || !collapsed.has(g.key);
            const onlineCount = g.rows.filter((r) => isOnline(r.status)).length;
            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-[rgba(150,180,245,.07)]"
                >
                  <Icon
                    icon="heroicons-mini:chevron-right"
                    className={`shrink-0 text-sm text-[#9db0d8] transition-transform ${open ? "rotate-90" : ""}`}
                  />
                  <Icon icon={g.icon} className="shrink-0 text-sm text-[#9db0d8]" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#f2f6ff]">
                    {g.label}
                  </span>
                  {/* online / total, so a recorder whose channels are all down is
                      visible before an operator searches its footage. */}
                  <span className="shrink-0 rounded-full bg-[rgba(150,180,245,.08)] px-1.5 text-[10px] font-semibold tabular-nums text-[#9db0d8]">
                    {onlineCount}/{g.rows.length}
                  </span>
                </button>

                {open && (
                  <div className="ml-3 space-y-0.5 border-l border-[rgba(150,180,245,.16)] pl-1.5">
                    {g.rows.map((r) => {
                      const on = checkedKeys.has(r.key);
                      const blocked = !on && atCap;
                      return (
                        <label
                          key={r.key}
                          title={blocked ? `${r.name} — uncheck one to add another` : r.name}
                          className={`flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left text-[13px] text-[#f2f6ff] transition ${
                            blocked
                              ? "cursor-not-allowed opacity-40"
                              : "cursor-pointer hover:bg-[rgba(150,180,245,.07)]"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            disabled={blocked}
                            onChange={() => onToggle(r.key)}
                          />
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition ${
                              on
                                ? "border-foreground bg-foreground text-background"
                                : "border-[rgba(150,180,245,.28)]"
                            }`}
                          >
                            {on && <Icon icon="heroicons-solid:check" className="text-[11px]" />}
                          </span>
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              isOnline(r.status) ? "bg-nb-good" : "bg-[#7e93bf]"
                            }`}
                            title={r.status || "unknown"}
                          />
                          <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
