"use client";

// L3 PLANT — one system drawn as a schematic. Inline SVG, no chart library.
//
// The drawing language is the one the NeuBit dashboard mockup set (chillers in
// a row, towers and condenser pumps on the condenser side, supply and return
// headers under the chillers, pumps on the pipe they serve). Its DATA is not
// taken — every glyph here is a row of `GET /bi/sites/{id}/plant`.
//
// WHAT THE COLOUR IS. A glyph's stroke, fill and state word are its DATA
// READINESS (`readiness.ts`) and nothing else. A metric is printed on the
// glyph as text — a value, "not known", or the refusal's status — and never
// tints it. The pipes are topology, in hues no readiness state uses.
//
// LEGIBILITY. The SVG is drawn at 1:1 in CSS pixels, so its text is the size it
// says. A plant wider than the console scrolls sideways INSIDE its own card;
// the page never does.
import type { KeyboardEvent, ReactNode } from "react";

import type { BiPlant, BiPlantEquipment, BiPlantSystem } from "@/lib/types";

import {
  PIPE,
  PUMP_CLASSES,
  classLabel,
  kindLabel,
  metricShort,
  metricView,
  metricsFor,
  readinessStyle,
  statusWords,
} from "./readiness";

const INK = "#eaf0ff";
const MUTED = "#9fb2d8";
const FAINT = "#6c7fa6";
const BUS = "rgba(130,165,235,.45)";
const MONO = "ui-monospace, Menlo, Consolas, monospace";

export interface SchematicProps {
  plant: BiPlant;
  selectedId: string | null;
  onSelect: (equipmentId: string) => void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Txt({
  x,
  y,
  children,
  size = 10,
  color = INK,
  weight = 500,
  anchor = "start",
  italic = false,
}: Readonly<{
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  color?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  italic?: boolean;
}>) {
  return (
    <text
      x={x}
      y={y}
      fill={color}
      fontSize={size}
      fontWeight={weight}
      textAnchor={anchor}
      fontFamily={MONO}
      fontStyle={italic ? "italic" : undefined}
    >
      {children}
    </text>
  );
}

function Pipe({ d, color, width = 5 }: Readonly<{ d: string; color: string; width?: number }>) {
  return (
    <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" opacity={0.5} />
  );
}

/** Slots reporting, of all the slots drawn — the one count every glyph carries. */
function slotLine(eq: BiPlantEquipment): string {
  const reporting = eq.slots.filter((s) => s.readiness === "reporting").length;
  return `${reporting}/${eq.slots.length} slots reporting`;
}

function countsTitle(eq: BiPlantEquipment): string {
  const parts = Object.entries(eq.readiness_counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${state}`);
  return parts.length ? parts.join(", ") : "no slots";
}

/** The props that make a glyph a control: a press or Enter/Space selects it. */
function pressable(eq: BiPlantEquipment, selected: boolean, onSelect: (id: string) => void) {
  const style = readinessStyle(eq.readiness);
  return {
    role: "button",
    tabIndex: 0,
    "aria-pressed": selected,
    "aria-label": `${eq.tag} — ${classLabel(eq.equipment_class)} — ${style.label}`,
    "data-equipment": eq.equipment_id,
    "data-readiness": eq.readiness,
    style: { cursor: "pointer", outline: "none" },
    onClick: () => onSelect(eq.equipment_id),
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(eq.equipment_id);
      }
    },
  } as const;
}

interface GlyphProps {
  eq: BiPlantEquipment;
  plant: BiPlant;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** The metric lines under a box glyph: a value, "not known", or the refusal's
 *  status in words — never a 0 and never an empty line. */
function MetricLines({
  eq,
  plant,
  x,
  y,
  w,
  max,
}: Readonly<{ eq: BiPlantEquipment; plant: BiPlant; x: number; y: number; w: number; max: number }>) {
  const defs = metricsFor(plant, eq);
  const shown = defs.slice(0, max);
  return (
    <>
      {shown.map((def, i) => {
        const v = metricView(def, eq.metrics?.[def.metric], eq);
        const yy = y + i * 15;
        const right =
          v.kind === "value" ? (
            <Txt x={x + w} y={yy} anchor="end" weight={700}>
              {clip(v.text, 12)}
            </Txt>
          ) : v.kind === "unknown" ? (
            <Txt x={x + w} y={yy} anchor="end" color={MUTED} size={9} italic>
              not known
            </Txt>
          ) : (
            <Txt x={x + w} y={yy} anchor="end" color={FAINT} size={9} italic>
              {clip(statusWords(v.status), 16)}
            </Txt>
          );
        return (
          <g key={def.metric} data-metric={def.metric} data-metric-kind={v.kind}>
            <title>{v.kind === "value" ? `${def.label ?? def.metric}: ${v.text}` : v.reason}</title>
            <Txt x={x} y={yy} color={FAINT} size={9.5}>
              {clip(metricShort(def), 7)}
            </Txt>
            {right}
          </g>
        );
      })}
      {defs.length > max && (
        <Txt x={x} y={y + max * 15} color={FAINT} size={9}>
          +{defs.length - max} more — select to see
        </Txt>
      )}
    </>
  );
}

function Frame({
  x,
  y,
  w,
  h,
  state,
  selected,
  rx = 8,
}: Readonly<{ x: number; y: number; w: number; h: number; state: string; selected: boolean; rx?: number }>) {
  const s = readinessStyle(state);
  return (
    <>
      {selected && (
        <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={rx + 3} fill="none" stroke={INK} strokeWidth={1.5} />
      )}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={rx}
        fill={`${s.color}1a`}
        stroke={s.color}
        strokeWidth={1.6}
        strokeDasharray={s.dash}
        data-part="frame"
      />
    </>
  );
}

// ── the glyphs ───────────────────────────────────────────────────────────────

const CH_W = 150;
const CH_H = 112;

function ChillerGlyph({ eq, plant, selected, onSelect, x, y }: Readonly<GlyphProps & { x: number; y: number }>) {
  const s = readinessStyle(eq.readiness);
  return (
    <g {...pressable(eq, selected, onSelect)}>
      <title>{`${eq.tag}${eq.name ? ` (${eq.name})` : ""} · ${classLabel(eq.equipment_class)} · ${s.label} — ${countsTitle(eq)}`}</title>
      <Frame x={x} y={y} w={CH_W} h={CH_H} state={eq.readiness} selected={selected} />
      {/* evaporator and condenser barrels — the chiller's own silhouette */}
      <rect x={x + CH_W - 44} y={y + 8} width={34} height={9} rx={3} fill="none" stroke={s.color} strokeWidth={1.2} />
      <rect x={x + CH_W - 44} y={y + 21} width={34} height={9} rx={3} fill="none" stroke={s.color} strokeWidth={1.2} />
      <Txt x={x + 10} y={y + 17} size={11.5} weight={700}>
        {clip(eq.tag, 11)}
      </Txt>
      <Txt x={x + 10} y={y + 31} size={9.5} color={s.color} weight={700}>
        {s.label.toUpperCase()}
      </Txt>
      <Txt x={x + 10} y={y + 46} size={9} color={MUTED}>
        {slotLine(eq)}
      </Txt>
      <MetricLines eq={eq} plant={plant} x={x + 10} y={y + 62} w={CH_W - 20} max={3} />
    </g>
  );
}

const TW_W = 124;
const TW_H = 66;

function Fan({ cx, cy, r, color }: Readonly<{ cx: number; cy: number; r: number; color: string }>) {
  return (
    <g>
      {[0, 90, 180, 270].map((a) => (
        <path
          key={a}
          transform={`rotate(${a} ${cx} ${cy})`}
          d={`M${cx} ${cy} q ${r * 0.5} ${-r * 0.55} ${r} ${-r * 0.08} q ${-r * 0.36} ${r * 0.28} ${-r} ${r * 0.08} z`}
          fill={color}
          opacity={0.85}
        />
      ))}
      <circle cx={cx} cy={cy} r={r + 2} fill="none" stroke={color} strokeWidth={1} opacity={0.6} />
    </g>
  );
}

function TowerGlyph({ eq, selected, onSelect, x, y }: Readonly<GlyphProps & { x: number; y: number }>) {
  const s = readinessStyle(eq.readiness);
  return (
    <g {...pressable(eq, selected, onSelect)}>
      <title>{`${eq.tag} · ${classLabel(eq.equipment_class)} · ${s.label} — ${countsTitle(eq)}`}</title>
      <Frame x={x} y={y} w={TW_W} h={TW_H} state={eq.readiness} selected={selected} />
      <Fan cx={x + 22} cy={y + 33} r={11} color={s.color} />
      <Txt x={x + 42} y={y + 20} size={11} weight={700}>
        {clip(eq.tag, 10)}
      </Txt>
      <Txt x={x + 42} y={y + 34} size={9.5} color={s.color} weight={700}>
        {s.label.toUpperCase()}
      </Txt>
      <Txt x={x + 42} y={y + 48} size={9} color={MUTED}>
        {`${eq.slots.filter((sl) => sl.readiness === "reporting").length}/${eq.slots.length} slots`}
      </Txt>
    </g>
  );
}

function PumpGlyph({
  eq,
  selected,
  onSelect,
  cx,
  cy,
  labelAbove,
}: Readonly<GlyphProps & { cx: number; cy: number; labelAbove: boolean }>) {
  const s = readinessStyle(eq.readiness);
  const tagY = labelAbove ? cy - 32 : cy + 30;
  return (
    <g {...pressable(eq, selected, onSelect)}>
      <title>{`${eq.tag} · ${classLabel(eq.equipment_class)} · ${s.label} — ${countsTitle(eq)}`}</title>
      {selected && <circle cx={cx} cy={cy} r={19} fill="none" stroke={INK} strokeWidth={1.5} />}
      <circle
        cx={cx}
        cy={cy}
        r={14}
        fill="#0b1224"
        stroke={s.color}
        strokeWidth={2}
        strokeDasharray={s.dash}
        data-part="frame"
      />
      <path d={`M${cx - 5} ${cy - 6} L${cx + 7} ${cy} L${cx - 5} ${cy + 6} Z`} fill={s.color} />
      <Txt x={cx} y={tagY} size={9.5} weight={700} anchor="middle">
        {clip(eq.tag, 11)}
      </Txt>
      <Txt x={cx} y={tagY + 12} size={8.5} color={s.color} weight={700} anchor="middle">
        {s.label.toUpperCase()}
      </Txt>
    </g>
  );
}

const HD_W = 68;

function HeaderGlyph({
  eq,
  selected,
  onSelect,
  x,
  y1,
  y2,
}: Readonly<GlyphProps & { x: number; y1: number; y2: number }>) {
  const s = readinessStyle(eq.readiness);
  const mid = (y1 + y2) / 2;
  return (
    <g {...pressable(eq, selected, onSelect)}>
      <title>{`${eq.tag} · ${classLabel(eq.equipment_class)} · ${s.label} — ${countsTitle(eq)}`}</title>
      <Frame x={x} y={y1} w={HD_W} h={y2 - y1} state={eq.readiness} selected={selected} rx={6} />
      <Txt x={x + HD_W / 2} y={mid - 2} size={9.5} weight={700} anchor="middle">
        {clip(eq.tag, 9)}
      </Txt>
      <Txt x={x + HD_W / 2} y={mid + 10} size={8.5} color={s.color} weight={700} anchor="middle">
        {s.label.toUpperCase()}
      </Txt>
    </g>
  );
}

const BOX_W = 136;
const BOX_H = 100;

function BoxGlyph({ eq, plant, selected, onSelect, x, y }: Readonly<GlyphProps & { x: number; y: number }>) {
  const s = readinessStyle(eq.readiness);
  return (
    <g {...pressable(eq, selected, onSelect)}>
      <title>{`${eq.tag}${eq.name ? ` (${eq.name})` : ""} · ${classLabel(eq.equipment_class)} · ${s.label} — ${countsTitle(eq)}`}</title>
      <Frame x={x} y={y} w={BOX_W} h={BOX_H} state={eq.readiness} selected={selected} />
      <Txt x={x + 10} y={y + 14} size={9} color={FAINT}>
        {clip(classLabel(eq.equipment_class), 20)}
      </Txt>
      <Txt x={x + 10} y={y + 29} size={11.5} weight={700}>
        {clip(eq.tag, 16)}
      </Txt>
      <Txt x={x + 10} y={y + 43} size={9.5} color={s.color} weight={700}>
        {s.label.toUpperCase()}
      </Txt>
      <Txt x={x + 10} y={y + 57} size={9} color={MUTED}>
        {slotLine(eq)}
      </Txt>
      <MetricLines eq={eq} plant={plant} x={x + 10} y={y + 73} w={BOX_W - 20} max={2} />
    </g>
  );
}

// ── the layouts ──────────────────────────────────────────────────────────────

const X0 = 20;

/** A chilled-water loop: condenser side on top, chillers in a row, CHW supply
 *  and return under them with the pumps on the pipe each serves. */
function ChwLoop({ system, plant, selectedId, onSelect }: Readonly<SchematicProps & { system: BiPlantSystem }>) {
  const eqs = system.equipment;
  const of = (cls: string) => eqs.filter((e) => e.equipment_class === cls);
  const towers = of("cooling_tower");
  const cwp = of("condenser_pump");
  const ch = of("chiller");
  const pp = of("chw_primary_pump");
  const sp = of("chw_secondary_pump");
  const hd = of("chw_header");
  const placed = new Set(["cooling_tower", "condenser_pump", "chiller", "chw_primary_pump", "chw_secondary_pump", "chw_header"]);
  const rest = eqs.filter((e) => !placed.has(e.equipment_class));

  const P = 172; // chiller / tower pitch
  const PUMP = 78; // pump pitch
  const hasCond = towers.length + cwp.length > 0;
  const towerY = 12;
  const condY = towerY + TW_H + 34;
  const cwpX0 = X0 + towers.length * P + 40;
  const cols = Math.max(ch.length, 1);
  const chTop = hasCond ? condY + 36 : 12;
  const supY = chTop + CH_H + 46;
  const retY = supY + 62;
  const tailX = X0 + cols * P;
  const pumpCols = Math.max(pp.length, sp.length);
  const hdX0 = tailX + pumpCols * PUMP + (pumpCols ? 24 : 0);
  const lineEnd = hdX0 + hd.length * 88 + 24;
  const condEnd = Math.max(cwpX0 + cwp.length * PUMP, X0 + (ch.length ? (ch.length - 1) * P + CH_W : 0));
  const restY = retY + 56;
  const W = Math.max(lineEnd, condEnd + 24, X0 + rest.length * (BOX_W + 18) + 20, 440);
  const H = rest.length ? restY + BOX_H + 12 : retY + 52;
  const sel = (e: BiPlantEquipment) => e.equipment_id === selectedId;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${system.name} schematic`}>
      {hasCond && (
        <g data-pipe="condenser">
          <Pipe d={`M${X0} ${condY} H${condEnd}`} color={PIPE.condenser} />
          {towers.map((t, i) => (
            <Pipe key={t.equipment_id} d={`M${X0 + i * P + TW_W / 2} ${towerY + TW_H} V${condY}`} color={PIPE.condenser} width={3.5} />
          ))}
          {ch.map((c, i) => (
            <Pipe key={c.equipment_id} d={`M${X0 + i * P + CH_W - 30} ${chTop} V${condY}`} color={PIPE.condenser} width={3.5} />
          ))}
          <Txt x={X0} y={condY - 7} size={8.5} color={PIPE.condenser}>
            condenser water
          </Txt>
        </g>
      )}
      <g data-pipe="supply">
        <Pipe d={`M${X0 + 30} ${supY} H${lineEnd}`} color={PIPE.supply} />
        {ch.map((c, i) => (
          <Pipe key={c.equipment_id} d={`M${X0 + i * P + 30} ${chTop + CH_H} V${supY}`} color={PIPE.supply} width={3.5} />
        ))}
        <Txt x={X0 + CH_W - 18} y={supY - 7} size={8.5} color={PIPE.supply}>
          CHW supply
        </Txt>
      </g>
      <g data-pipe="return">
        <Pipe d={`M${X0 + CH_W - 30} ${retY} H${lineEnd}`} color={PIPE.return} />
        {ch.map((c, i) => (
          <Pipe key={c.equipment_id} d={`M${X0 + i * P + CH_W - 30} ${chTop + CH_H} V${retY}`} color={PIPE.return} width={3.5} />
        ))}
        <Txt x={X0 + CH_W - 18} y={retY - 7} size={8.5} color={PIPE.return}>
          CHW return
        </Txt>
      </g>

      {towers.map((t, i) => (
        <TowerGlyph key={t.equipment_id} eq={t} plant={plant} selected={sel(t)} onSelect={onSelect} x={X0 + i * P} y={towerY} />
      ))}
      {cwp.map((p, i) => (
        <PumpGlyph
          key={p.equipment_id}
          eq={p}
          plant={plant}
          selected={sel(p)}
          onSelect={onSelect}
          cx={cwpX0 + 38 + i * PUMP}
          cy={condY}
          labelAbove
        />
      ))}
      {ch.map((c, i) => (
        <ChillerGlyph key={c.equipment_id} eq={c} plant={plant} selected={sel(c)} onSelect={onSelect} x={X0 + i * P} y={chTop} />
      ))}
      {sp.map((p, i) => (
        <PumpGlyph
          key={p.equipment_id}
          eq={p}
          plant={plant}
          selected={sel(p)}
          onSelect={onSelect}
          cx={tailX + 38 + i * PUMP}
          cy={supY}
          labelAbove
        />
      ))}
      {pp.map((p, i) => (
        <PumpGlyph
          key={p.equipment_id}
          eq={p}
          plant={plant}
          selected={sel(p)}
          onSelect={onSelect}
          cx={tailX + 38 + i * PUMP}
          cy={retY}
          labelAbove={false}
        />
      ))}
      {hd.map((h, i) => (
        <HeaderGlyph
          key={h.equipment_id}
          eq={h}
          plant={plant}
          selected={sel(h)}
          onSelect={onSelect}
          x={hdX0 + i * 88}
          y1={supY - 16}
          y2={retY + 16}
        />
      ))}
      {rest.map((e, i) => (
        <BoxGlyph key={e.equipment_id} eq={e} plant={plant} selected={sel(e)} onSelect={onSelect} x={X0 + i * (BOX_W + 18)} y={restY} />
      ))}
    </svg>
  );
}

/** Left edges along a bus: a box takes a box's width, a pump a pump's. */
function placeOnBus(equipment: BiPlantEquipment[]) {
  const items: { eq: BiPlantEquipment; pump: boolean; at: number }[] = [];
  let cursor = X0;
  for (const eq of equipment) {
    const pump = PUMP_CLASSES.has(eq.equipment_class);
    items.push({ eq, pump, at: cursor });
    cursor += pump ? 84 : BOX_W + 18;
  }
  return { items, cursor };
}

/** Any other system: its equipment on one line — boxes above it, pumps on it. */
function BusLayout({
  equipment,
  label,
  plant,
  selectedId,
  onSelect,
}: Readonly<SchematicProps & { equipment: BiPlantEquipment[]; label: string }>) {
  const boxY = 12;
  const busY = boxY + BOX_H + 28;
  const { items, cursor } = placeOnBus(equipment);
  const busEnd = Math.max(cursor - 18, X0 + 120);
  const W = Math.max(cursor + 20, 440);
  const H = busY + 50;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${label} schematic`}>
      <Pipe d={`M${X0} ${busY} H${busEnd}`} color={BUS} width={3} />
      {items.map(({ eq, pump, at }) =>
        pump ? null : <Pipe key={`s-${eq.equipment_id}`} d={`M${at + BOX_W / 2} ${boxY + BOX_H} V${busY}`} color={BUS} width={2} />,
      )}
      {items.map(({ eq, pump, at }) =>
        pump ? (
          <PumpGlyph
            key={eq.equipment_id}
            eq={eq}
            plant={plant}
            selected={eq.equipment_id === selectedId}
            onSelect={onSelect}
            cx={at + 40}
            cy={busY}
            labelAbove={false}
          />
        ) : (
          <BoxGlyph
            key={eq.equipment_id}
            eq={eq}
            plant={plant}
            selected={eq.equipment_id === selectedId}
            onSelect={onSelect}
            x={at}
            y={boxY}
          />
        ),
      )}
    </svg>
  );
}

function SystemHead({
  name,
  kind,
  state,
  count,
  title,
}: Readonly<{ name: string; kind: string; state: string | null; count: number; title?: string }>) {
  const s = state ? readinessStyle(state) : null;
  return (
    <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5" title={title}>
      <h3 className="text-[12.5px] font-semibold text-nb-ink">{name}</h3>
      <span className="text-[10.5px] text-nb-faint">{kind}</span>
      <span className="font-mono text-[10.5px] text-nb-faint">· {count} equipment</span>
      {s && (
        <span className="font-mono text-[10px] font-semibold tracking-[.6px]" style={{ color: s.color }} title={s.title}>
          {s.label.toUpperCase()}
        </span>
      )}
    </div>
  );
}

/**
 * The building's plant: every system as a drawing, then any equipment whose
 * system the store has never heard of. Each drawing scrolls sideways inside its
 * own box when it is wider than the console — the page never does.
 */
export default function PlantSchematic({ plant, selectedId, onSelect }: Readonly<SchematicProps>) {
  const shared = { plant, selectedId, onSelect };
  return (
    <div className="space-y-4">
      {plant.systems.map((system) => (
        <section key={system.system_id} data-system={system.system_id}>
          <SystemHead
            name={system.name}
            kind={kindLabel(system.kind)}
            state={system.equipment.length ? system.readiness : null}
            count={system.equipment.length}
            title={system.description ?? undefined}
          />
          <div className="nav-scroll overflow-x-auto rounded-[10px] border border-nb-line/60 bg-[rgba(6,11,26,.35)] p-2">
            {system.equipment.length ? (
              system.kind === "chw_plant" ? (
                <ChwLoop system={system} {...shared} />
              ) : (
                <BusLayout equipment={system.equipment} label={system.name} {...shared} />
              )
            ) : (
              // An empty system is stated, not drawn as a pipe to nowhere.
              <p className="px-1 py-2 text-[11px] text-nb-faint">No equipment in this system yet.</p>
            )}
          </div>
        </section>
      ))}
      {plant.unassigned_equipment.length > 0 && (
        <section data-system="unassigned">
          <SystemHead
            name="Not in any system"
            kind="the store has no record of these equipments' system"
            state={null}
            count={plant.unassigned_equipment.length}
          />
          <div className="nav-scroll overflow-x-auto rounded-[10px] border border-nb-line/60 bg-[rgba(6,11,26,.35)] p-2">
            <BusLayout equipment={plant.unassigned_equipment} label="Not in any system" {...shared} />
          </div>
        </section>
      )}
    </div>
  );
}
