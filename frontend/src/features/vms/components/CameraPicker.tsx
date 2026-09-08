"use client";

// Pick cameras, BY RECORDER.
//
// A flat checkbox grid of camera names is fine for four cameras and useless for
// four hundred: "Channel 1" exists on every recorder in the estate, so the list
// reads as a bag of duplicates with no way to tell which box a name belongs to.
// The estate's real shape is recorder → cameras, and that is what this shows.
//
// One search box filters BOTH levels: typing a recorder's name keeps its whole
// group, typing a camera's name keeps the matching cameras and the groups that
// hold them. A group with nothing left is dropped rather than left as an empty
// header, and a group that a search brought back is opened, because a match
// hidden inside a collapsed section reads as no match at all.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { Input } from "@/components/ui/kit";
import type { EstateCamera } from "../types";

/** Cameras the VMS owns rows for belong to no recorder. */
export const LOCAL_GROUP = "This VMS";

export interface CameraPickerProps {
  cameras: EstateCamera[];
  selected: string[];
  onToggle: (id: string) => void;
  /** Select or clear a whole recorder in one go. */
  onToggleMany?: (ids: string[], select: boolean) => void;
  loading?: boolean;
  /** What to say when there is nothing to pick — an outage is not an empty estate. */
  empty?: string;
}

interface Group {
  key: string;
  name: string;
  cameras: EstateCamera[];
}

/** recorder → its cameras. Order: recorders by name, local rows last. */
function groupByRecorder(cameras: EstateCamera[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const cam of cameras) {
    const key = cam.node_id || "__local__";
    const name = cam.node_name || LOCAL_GROUP;
    let g = byKey.get(key);
    if (!g) {
      g = { key, name, cameras: [] };
      byKey.set(key, g);
    }
    g.cameras.push(cam);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.key === "__local__") return 1;
    if (b.key === "__local__") return -1;
    return a.name.localeCompare(b.name);
  });
}

export default function CameraPicker({
  cameras,
  selected,
  onToggle,
  onToggleMany,
  loading,
  empty = "No cameras",
}: CameraPickerProps) {
  const [q, setQ] = useState("");
  // Which groups the operator has collapsed. Open by default: a picker that
  // starts shut hides the estate behind one more click.
  const [shut, setShut] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = groupByRecorder(cameras);
    if (!term) return all;
    return all
      .map((g) => {
        // A recorder that matches keeps ALL of its cameras — "show me everything
        // on rec-a" is the other half of what this box is for.
        if (g.name.toLowerCase().includes(term)) return g;
        const hits = g.cameras.filter((c) => (c.name || "").toLowerCase().includes(term));
        return hits.length ? { ...g, cameras: hits } : null;
      })
      .filter((g): g is Group => g !== null);
  }, [cameras, q]);

  const searching = q.trim().length > 0;

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-1 py-3 text-[11px] text-nb-soft">
        <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
      </div>
    );
  }
  if (cameras.length === 0) {
    return <p className="px-1 py-3 text-[11px] text-nb-soft">{empty}</p>;
  }

  return (
    <div className="mt-1 space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search recorder or camera…"
          aria-label="Search recorder or camera"
          className="!h-8 !py-1 text-xs"
          wrapperClassName="flex-1"
        />
        <span className="shrink-0 font-mono text-[10.5px] text-nb-faint">
          {selected.length} selected
        </span>
      </div>

      <div className="max-h-56 space-y-1 overflow-y-auto rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] p-1.5">
        {groups.length === 0 ? (
          <p className="px-1 py-3 text-center text-[11px] text-nb-soft">No camera matches that.</p>
        ) : (
          groups.map((g) => {
            const ids = g.cameras.map((c) => c.id);
            const on = ids.filter((id) => selected.includes(id));
            const allOn = on.length === ids.length && ids.length > 0;
            // A search re-opens what it matched: a hit inside a collapsed group
            // reads as no hit.
            const open = searching || !shut[g.key];
            return (
              <div key={g.key}>
                <div className="flex items-center gap-1.5 rounded-[7px] px-1.5 py-1 hover:bg-[rgba(96,165,250,.06)]">
                  <button
                    type="button"
                    onClick={() => setShut((s) => ({ ...s, [g.key]: !s[g.key] }))}
                    aria-expanded={open}
                    aria-label={`${g.name} cameras`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <Icon
                      icon={open ? "heroicons-mini:chevron-down" : "heroicons-mini:chevron-right"}
                      className="shrink-0 text-sm text-nb-faint"
                    />
                    <Icon
                      icon={g.key === "__local__" ? "heroicons-outline:server" : "heroicons:cpu-chip"}
                      className="shrink-0 text-[13px] text-nb-blueb"
                    />
                    <span className="truncate text-[11.5px] font-medium text-nb-ink">{g.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-nb-faint">
                      {on.length}/{ids.length}
                    </span>
                  </button>
                  {onToggleMany && (
                    <button
                      type="button"
                      onClick={() => onToggleMany(ids, !allOn)}
                      className="shrink-0 rounded-[6px] border border-nb-line px-1.5 py-0.5 text-[10px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
                    >
                      {allOn ? "None" : "All"}
                    </button>
                  )}
                </div>

                {open && (
                  <div className="grid grid-cols-2 gap-1 pl-5 pr-1 pt-0.5">
                    {g.cameras.map((c) => {
                      const checked = selected.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-[11px] ${
                            checked
                              ? "bg-[rgba(96,165,250,.1)] text-nb-blueb"
                              : "text-nb-soft hover:bg-[rgba(96,165,250,.06)]"
                          }`}
                        >
                          <input type="checkbox" checked={checked} onChange={() => onToggle(c.id)} />
                          <span className="truncate" title={c.name}>
                            {c.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
