"use client";

// SOP detail builder — the right pane when a SOP is selected. A header (name +
// meta + delete) over an underline sub-nav: Designer | Properties | Triggers.
//   • Designer   → the visual state-machine canvas (SopCanvas).
//   • Properties → a full-width form editing the SOP's own metadata (SopForm).
//   • Triggers   → read-only list of triggers targeting this SOP.
// Mirrors the v2 sop-builder layout, rethemed to v3 tokens.
import { useState } from "react";
import { Icon } from "@iconify/react";

import { titleize, idOf } from "@/lib/format";
import SopCanvas from "../../sop-designer/SopCanvas";
import SopForm from "./SopForm";
import SopTriggersList from "./SopTriggersList";

const sopIdOf = (s) => idOf(s, "id", "sop_id");

const SUBTABS = [
  { key: "designer", label: "Designer", icon: "heroicons-outline:squares-2x2" },
  { key: "properties", label: "Properties", icon: "heroicons-outline:adjustments-horizontal" },
  { key: "triggers", label: "Triggers", icon: "heroicons:bolt" },
];

export default function SopBuilder({ sop, onDelete, onSaved }) {
  const [tab, setTab] = useState("designer");
  const id = sopIdOf(sop);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground truncate">{sop.name}</h2>
          {sop.description && <p className="mt-0.5 text-xs text-muted">{sop.description}</p>}
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted flex-wrap">
            {typeof sop.version === "number" && <span className="font-mono">v{sop.version}</span>}
            <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 capitalize">{titleize(sop.default_priority || "medium")}</span>
            {sop.sla_hours != null && <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5">SLA {sop.sla_hours}h</span>}
            <span className={`rounded-full px-2 py-0.5 ${sop.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>
              {sop.is_active === false ? "Inactive" : "Active"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setTab("properties")}
            className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
          >
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20"
          >
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      {/* Underline sub-nav */}
      <nav className="flex items-stretch border-b border-card-border px-2">
        {SUBTABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                active ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              <Icon icon={t.icon} className="text-base" />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "designer" ? (
          <div className="px-6 py-5">
            <SopCanvas key={id} sopId={id} />
          </div>
        ) : tab === "properties" ? (
          <SopForm
            key={id}
            sop={sop}
            onCancel={() => setTab("designer")}
            onSaved={(saved) => { onSaved?.(saved); setTab("designer"); }}
          />
        ) : (
          <SopTriggersList sopId={id} />
        )}
      </div>
    </div>
  );
}
