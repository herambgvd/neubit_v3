"use client";

// Read-only detail pane for an alert format (right side of the Formats
// master-detail). Header (name + severity/priority badges + edit/delete) over a
// 3-tab body — Overview (identity + timestamps), Presentation (colour/icon/sound),
// and Workflow link (linked SOP + mode) — mirroring neubit_v2's format detail.
import { useState } from "react";
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { titleize } from "@/lib/format";
import { PRIORITY_COLOR } from "../../constants";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "presentation", label: "Presentation" },
  { key: "workflow", label: "Workflow link" },
];

export default function FormatDetail({ format, sopName, onEdit, onDelete }) {
  const f = format;
  const [tab, setTab] = useState("overview");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md text-white shrink-0" style={{ background: f.color_code || "#ef4444" }}>
            <Icon icon={f.icon || "heroicons-outline:swatch"} className="text-lg" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground truncate">{f.name}</h2>
              <Badge color={PRIORITY_COLOR[f.severity] || "slate"}>{titleize(f.severity)}</Badge>
              <Badge color={PRIORITY_COLOR[f.priority] || "slate"}>{titleize(f.priority)}</Badge>
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${f.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{f.is_active === false ? "Inactive" : "Active"}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted font-mono">{f.alert_code}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="px-2" />

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {tab === "overview" ? (
          <OverviewPanel f={f} />
        ) : tab === "presentation" ? (
          <PresentationPanel f={f} />
        ) : (
          <WorkflowLinkPanel f={f} sopName={sopName} />
        )}
      </div>
    </div>
  );
}

function OverviewPanel({ f }) {
  return (
    <div className="space-y-6">
      {f.description && <p className="text-sm text-muted">{f.description}</p>}
      <Section title="Identity">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
          <Row label="Name" value={f.name || "—"} />
          <Row label="Alert code" value={f.alert_code || "—"} mono />
          <Row label="Category" value={titleize(f.category || "custom")} />
          <Row label="Severity" value={titleize(f.severity)} />
          <Row label="Priority" value={titleize(f.priority)} />
          <Row label="Active" value={f.is_active === false ? "No" : "Yes"} />
        </div>
      </Section>
      <Section title="Timestamps">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
          <Row label="Created" value={f.created_at ? new Date(f.created_at).toLocaleString() : "—"} />
          <Row label="Updated" value={f.updated_at ? new Date(f.updated_at).toLocaleString() : "—"} />
        </div>
      </Section>
    </div>
  );
}

function PresentationPanel({ f }) {
  return (
    <div className="space-y-6">
      <Section title="Visual">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted/70">Colour</div>
            <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
              <span className="h-4 w-4 rounded border border-card-border" style={{ background: f.color_code || "#ef4444" }} />
              <span className="font-mono">{f.color_code || "—"}</span>
            </div>
          </div>
          <Row label="Icon" value={f.icon || "—"} mono={!!f.icon} />
        </div>
      </Section>
      <Section title="Audio">
        <Row label="Alert sound" value={f.alert_sound ? "On — plays a sound when triggered" : "Off"} />
      </Section>
    </div>
  );
}

function WorkflowLinkPanel({ f, sopName }) {
  const linked = !!f.sop_id;
  return (
    <div className="space-y-6">
      <Section title="Linked SOP">
        {linked ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <Row label="SOP" value={sopName || f.sop_id} />
            <Row label="SOP mode" value={titleize(f.sop_mode || "manual")} />
          </div>
        ) : (
          <p className="text-sm text-muted/70">No SOP linked — alerts of this kind won&apos;t auto-trigger a workflow.</p>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted/70">{label}</div>
      <div className={`text-sm text-foreground ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
