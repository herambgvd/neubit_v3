"use client";

// Read-only DDS hardware inventory. Ported from neubit_v2's hardware-tab.jsx:
// a section selector (Sites/Controllers/Readers/Inputs/Outputs/Alarm Zones/Areas)
// and a per-section table using the reference column configs (with on/off, purpose
// and bypass pills). Column configs live in constants.js; pill rendering is here.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";
import { HARDWARE_SECTIONS, HARDWARE_COLUMNS, PURPOSE_MAP } from "../constants";

function OnPill({ label }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500">
      <Icon icon="heroicons-solid:check-circle" className="text-[10px]" />
      {label}
    </span>
  );
}
function OffPill({ label }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[10px] font-medium text-muted">
      <Icon icon="heroicons-solid:minus-circle" className="text-[10px]" />
      {label}
    </span>
  );
}

function renderPill(col, value) {
  if (col.pill === "onoff") return value ? <OnPill label={col.on} /> : <OffPill label={col.off} />;
  if (col.pill === "purpose")
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-500">
        {PURPOSE_MAP[value] || value || "—"}
      </span>
    );
  if (col.pill === "bypass")
    return value ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
        <Icon icon="heroicons-solid:check-circle" className="text-[10px]" />
        Bypassed
      </span>
    ) : (
      <span className="text-[10px] text-muted/70">—</span>
    );
  return null;
}

function Cell({ value }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted/70">—</span>;
  if (typeof value === "object") return <code className="text-[10px] text-muted">{JSON.stringify(value)}</code>;
  const str = String(value);
  return str.length > 60 ? <span title={str}>{str.slice(0, 60)}…</span> : str;
}

function pickColumns(items) {
  const PREFERRED = ["Name", "UID", "Description", "ControllerUID", "ReaderUID", "InputType", "OutputType", "SiteUID", "AreaName", "Status"];
  if (!items.length) return [];
  const keys = new Set();
  items.slice(0, 50).forEach((it) => Object.keys(it || {}).forEach((k) => keys.add(k)));
  const ordered = [];
  PREFERRED.forEach((f) => {
    if (keys.has(f)) {
      ordered.push(f);
      keys.delete(f);
    }
  });
  Array.from(keys)
    .filter((k) => !k.startsWith("@"))
    .slice(0, 8 - ordered.length)
    .forEach((k) => ordered.push(k));
  return ordered;
}

export default function HardwareTab({ instanceId }) {
  const [section, setSection] = useState("sites");

  const q = useQuery({
    queryKey: ["ac-hw", instanceId, section],
    queryFn: () => gates.hardware.list(instanceId, section),
    enabled: !!instanceId,
  });
  const items = asItems(q.data);
  const colDefs = HARDWARE_COLUMNS[section] || null;
  const genericCols = colDefs ? null : pickColumns(items);

  const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted";

  return (
    <div className="flex h-full flex-col">
      {/* Section selector */}
      <div className="flex items-center gap-2 border-b border-card-border pb-3">
        <Icon icon="heroicons-outline:cpu-chip" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Hardware</span>
        <div className="ml-2 flex flex-wrap gap-1">
          {HARDWARE_SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                section === s.key ? "bg-foreground text-background" : "bg-hover text-muted hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="ml-auto rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{items.length}</span>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto pt-2">
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
          </div>
        ) : q.isError ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
            {apiError(q.error, "Could not load — check that the controller is reachable and synced.")}
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-xs text-muted/70">No items reported by the controller.</div>
        ) : colDefs ? (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-hover">
              <tr>
                {colDefs.map((col) => (
                  <th key={col.key} className={th}>
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {items.map((it, i) => (
                <tr key={it.UID || it.uid || i} className="hover:bg-hover/50">
                  {colDefs.map((col) => {
                    const val = it[col.key];
                    return (
                      <td key={col.key} className={`px-3 py-2 align-top text-muted ${col.mono ? "font-mono text-[11px]" : ""}`}>
                        {col.pill ? (
                          renderPill(col, val)
                        ) : col.truncate ? (
                          <span title={String(val ?? "")}>
                            {typeof val === "string" && val.length > col.truncate ? `${val.slice(0, col.truncate)}…` : String(val ?? "—")}
                          </span>
                        ) : (
                          <Cell value={val} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-hover">
              <tr>
                {genericCols.map((c) => (
                  <th key={c} className={th}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {items.map((it, i) => (
                <tr key={it.UID || it.uid || i} className="hover:bg-hover/50">
                  {genericCols.map((c) => (
                    <td key={c} className="px-3 py-2 align-top text-muted">
                      <Cell value={it[c]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
