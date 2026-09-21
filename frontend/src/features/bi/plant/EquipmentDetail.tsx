"use client";

// L3 PLANT — the piece of equipment an operator pressed: its metrics (a value
// with its working, "not known", or a refusal with its reason and the link that
// fixes it) and its slots (readiness, the bound point, the latest value, and
// why a slot is not reporting).
//
// Label density. Each reason is `<Reason>`: the lead sentence prints, the rest
// is on hover and behind "why".
import Link from "next/link";
import { Icon } from "@iconify/react";

import { fmtRelative } from "@/lib/format";
import type { BiPlant, BiPlantEquipment, BiPlantMetricDef, BiPlantSlot } from "@/lib/types";

import Reason from "../components/Reason";
import { fmtReading } from "../constants";
import { infraDesignerHref } from "../setup/routes";
import {
  classLabel,
  isMissingFact,
  isSlotRefusal,
  metricView,
  metricsFor,
  readinessStyle,
  statusWords,
  type MetricView,
} from "./readiness";

export interface EquipmentDetailProps {
  eq: BiPlantEquipment;
  plant: BiPlant;
  siteId: string;
}

function StateChip({ state }: Readonly<{ state: string }>) {
  const s = readinessStyle(state);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-px font-mono text-[9.5px] font-semibold tracking-[.5px]"
      style={{ color: s.color, borderColor: `${s.color}66`, borderStyle: s.dash ? "dashed" : "solid" }}
      title={s.title}
      data-state={state}
    >
      {s.label.toUpperCase()}
    </span>
  );
}

const linkCls = "inline-flex items-center gap-1 text-[11px] text-nb-blueb transition hover:underline";

/** The metrics the equipment's class has, plus any outcome the server sent for
 *  a metric the list did not name — shown, never dropped. */
function metricRows(plant: BiPlant, eq: BiPlantEquipment): BiPlantMetricDef[] {
  const defs = metricsFor(plant, eq);
  const named = new Set(defs.map((d) => d.metric));
  const extra = Object.keys(eq.metrics ?? {})
    .filter((k) => !named.has(k))
    .map<BiPlantMetricDef>((k) => ({
      metric: k,
      version: eq.metrics[k]!.version,
      label: k,
      precision: null,
      equipment_class: eq.equipment_class,
      slots: [],
      resolution: "",
    }));
  return [...defs, ...extra];
}

function MetricFix({ view, eq, siteId }: Readonly<{ view: MetricView; eq: BiPlantEquipment; siteId: string }>) {
  if (isMissingFact(view)) {
    return (
      <Link href={infraDesignerHref(siteId, eq.equipment_id)} className={linkCls} data-fix="missing_fact">
        Record it on {eq.tag} <Icon icon="heroicons:arrow-up-right" className="text-[11px]" />
      </Link>
    );
  }
  if (isSlotRefusal(view)) {
    return (
      <Link href={infraDesignerHref(siteId, eq.equipment_id)} className={linkCls} data-fix="slot">
        Bind the slot on {eq.tag} <Icon icon="heroicons:arrow-up-right" className="text-[11px]" />
      </Link>
    );
  }
  if (view.kind === "refused" && (view.status === "unit_unknown" || view.status === "unit_mismatch")) {
    // The unit is set on the GATEWAY, beside the point's live value, and it
    // travels here on every reading. There is no screen on this platform to
    // send anybody to, so the refusal says where instead of offering a link
    // that would land on a page that cannot change it.
    return (
      <span className="text-nb-faint" data-fix="unit">
        set the unit on the gateway
      </span>
    );
  }
  return null;
}

function MetricRow({ def, eq, siteId }: Readonly<{ def: BiPlantMetricDef; eq: BiPlantEquipment; siteId: string }>) {
  const view = metricView(def, eq.metrics?.[def.metric], eq);
  return (
    <li
      className="rounded-[8px] border border-nb-line bg-[rgba(6,11,26,.45)] px-2.5 py-1.5"
      data-metric={def.metric}
      data-metric-kind={view.kind}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11.5px] text-nb-soft" title={`${def.metric} v${def.version}`}>
          {def.label ?? def.metric}
        </span>
        {view.kind === "value" ? (
          <span className="font-mono text-[13px] font-semibold text-nb-ink">{view.text}</span>
        ) : view.kind === "unknown" ? (
          <span className="font-mono text-[11px] italic text-nb-muted">not known</span>
        ) : (
          <span className="font-mono text-[10.5px] italic text-nb-faint">refused · {statusWords(view.status)}</span>
        )}
      </div>
      {view.kind === "value" ? (
        view.arithmetic && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-nb-faint" title={view.arithmetic}>
            {view.arithmetic}
          </p>
        )
      ) : (
        <Reason text={view.reason} className="mt-0.5 text-[10.5px] leading-relaxed text-nb-faint" />
      )}
      <MetricFix view={view} eq={eq} siteId={siteId} />
    </li>
  );
}

function slotValue(slot: BiPlantSlot): { text: string; title?: string } {
  if (slot.readiness === "reporting" && slot.latest) {
    const v = fmtReading({ num: slot.latest.value, txt: slot.latest.text });
    const unit = slot.point?.unit_confirmed && slot.point.unit ? ` ${slot.point.unit}` : "";
    return { text: `${v}${unit}`, title: slot.latest.t ? `read ${fmtRelative(slot.latest.t)}` : undefined };
  }
  if (slot.readiness === "silent" && slot.point?.last_seen_at) {
    return { text: `last ${fmtRelative(slot.point.last_seen_at)}`, title: "no reading inside the window" };
  }
  return { text: "—" };
}

function SlotRow({ slot }: Readonly<{ slot: BiPlantSlot }>) {
  const value = slotValue(slot);
  const needs = slot.required_by.length ? `read by ${slot.required_by.join(", ")}` : undefined;
  return (
    <li
      className="rounded-[8px] border border-nb-line bg-[rgba(6,11,26,.45)] px-2.5 py-1.5"
      data-slot={slot.slot}
      data-readiness={slot.readiness}
    >
      <div className="flex items-center gap-2">
        <StateChip state={slot.readiness} />
        <span className="font-mono text-[11px] text-nb-ink" title={slot.label}>
          {slot.slot}
        </span>
        {!slot.declared && (
          <span className="text-[10px] italic text-nb-faint" title="Nobody created this slot; a metric reads it, so it is drawn as unbound.">
            not created
          </span>
        )}
        <span className="ml-auto font-mono text-[11.5px] text-nb-soft" title={value.title}>
          {value.text}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-nb-faint" title={needs}>
        {slot.binding ? (
          <span className="font-mono">
            {slot.binding.device_tag} / {slot.binding.point_tag}
          </span>
        ) : (
          <span>not bound</span>
        )}
        {slot.point && !slot.point.unit_confirmed && (
          <span className="text-nb-warn" title="A unit is recorded on the gateway and travels here on every reading.">
            no unit
          </span>
        )}
      </div>
      {slot.readiness !== "reporting" && slot.reason && (
        <Reason text={slot.reason} className="mt-0.5 text-[10.5px] leading-relaxed text-nb-faint" />
      )}
      {slot.candidates.length > 1 && (
        <ul className="mt-1 space-y-0.5">
          {slot.candidates.map((c) => (
            <li key={c.point_id} className="font-mono text-[10px] text-nb-faint">
              {c.device_tag} / {c.point_tag} · {c.reported_in_window ? "reported" : `last ${fmtRelative(c.last_seen_at)}`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Recorded design facts, as recorded. An absent one is absent — never a 0. */
function designLine(eq: BiPlantEquipment): string | null {
  const parts = Object.entries(eq.design ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k} ${v}${eq.design_units?.[k] ? ` ${eq.design_units[k]}` : ""}`);
  return parts.length ? parts.join(" · ") : null;
}

export default function EquipmentDetail({ eq, plant, siteId }: Readonly<EquipmentDetailProps>) {
  const metrics = metricRows(plant, eq);
  const design = designLine(eq);
  const reporting = eq.slots.filter((s) => s.readiness === "reporting").length;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" data-detail={eq.equipment_id}>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold text-nb-ink">{eq.tag}</h2>
          <StateChip state={eq.readiness} />
        </div>
        <p className="truncate text-[11px] text-nb-faint">
          {classLabel(eq.equipment_class)}
          {eq.name ? ` · ${eq.name}` : ""}
        </p>
        <p className="truncate font-mono text-[10.5px] text-nb-faint" title={design ?? "No design fact is recorded on this equipment."}>
          {design ?? "no design facts recorded"}
        </p>
        <Link href={infraDesignerHref(siteId, eq.equipment_id)} className={linkCls}>
          Open in the designer <Icon icon="heroicons:arrow-up-right" className="text-[11px]" />
        </Link>
      </header>

      {metrics.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-muted">Metrics</h3>
          <ul className="space-y-1.5">
            {metrics.map((def) => (
              <MetricRow key={def.metric} def={def} eq={eq} siteId={siteId} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-muted">
          Slots <span className="font-mono normal-case tracking-normal text-nb-faint">{reporting}/{eq.slots.length} reporting</span>
        </h3>
        {eq.slots.length ? (
          <ul className="space-y-1.5">
            {eq.slots.map((slot) => (
              <SlotRow key={slot.slot} slot={slot} />
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-nb-faint">No slots — nothing about this equipment can be read yet.</p>
        )}
      </section>
    </div>
  );
}
