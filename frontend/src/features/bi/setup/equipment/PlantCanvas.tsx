"use client";

// BI → Setup → Equipment: the building's plant, drawn, with every machine the
// platform can recognise already ON the drawing.
//
// SOLID boxes are saved equipment; DASHED boxes are proposals — a device placed
// in this building that looks like a machine nobody has saved yet. Click one and
// it opens where it sits (NodePopover). Nothing is saved until a person presses
// Save; the drawing re-reads every 15 seconds, so a value on it is a live one.
//
// One drawing per system kind: the chilled-water loop between its headers, the
// power chain as a single-line (main incomer → incomers → boards), air handling
// and water as groups. The tabs say how much of each is saved.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { IconButton } from "@/components/console";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { BiPlant, InfraVocabulary, InfrastructureTree } from "@/lib/types";

import { bi } from "../../api";
import { taskHref } from "../routes";
import DesignFacts from "./DesignFacts";
import NodePopover, { type SaveChoice } from "./NodePopover";
import ScheduleImport from "./ScheduleImport";
import SlotList from "./SlotList";
import {
  KINDS,
  KIND_LABEL,
  SYSTEM_NAME,
  buildDrawing,
  chainOf,
  countsOf,
  type Kind,
  type Node,
  type Suggestions,
  type Tree,
} from "./drawing";
import { factsOf, indexVocabulary, slotsOf } from "./vocabulary";

const LIVE_MS = 15_000;
const POP_W = 560;

/** The device a node stands for — the same for its proposal and, once saved,
 *  for the equipment it became, so a box keeps its place when it turns solid. */
const deviceOf = (n: Node): string | null =>
  n.device?.device_tag ?? n.equipment?.slots.find((s) => s.binding)?.binding?.device_tag ?? null;

function agoLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "updated just now";
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.round(s / 60)} min ago`;
}

export default function PlantCanvas({
  siteId,
  vocab,
  mayWrite,
  initialEquipmentId = null,
  initialImporting = false,
}: Readonly<{
  siteId: string;
  vocab: InfraVocabulary;
  mayWrite: boolean;
  initialEquipmentId?: string | null;
  initialImporting?: boolean;
}>) {
  const qc = useQueryClient();
  const still = !!useReducedMotion();
  const ix = useMemo(() => indexVocabulary(vocab), [vocab]);
  const classKinds = useMemo(
    () => Object.fromEntries(vocab.equipment_classes.map((c) => [c.key, c.system_kinds])),
    [vocab],
  );

  const plantQ = useQuery<BiPlant>({
    queryKey: ["bi-plant-live", siteId],
    queryFn: () => bi.plant(siteId),
    refetchInterval: LIVE_MS,
  });
  const suggestQ = useQuery<Suggestions>({
    queryKey: ["bi-equipment-suggestions", siteId],
    queryFn: () => bi.equipmentSuggestions(siteId),
    refetchInterval: LIVE_MS,
  });
  const treeQ = useQuery<InfrastructureTree>({
    queryKey: ["infra-tree", siteId],
    queryFn: () => siteInfrastructure.tree(siteId),
  });

  // Devices saved in this session that the reporting mirror has not caught up
  // with yet: drawn solid at once, never offered a second time.
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const drawing = useMemo(() => {
    const d = buildDrawing(plantQ.data, suggestQ.data, classKinds);
    if (!pending.size) return d;
    for (const k of KINDS) {
      d[k] = d[k].map((n) => (!n.saved && pending.has(n.label) ? { ...n, saved: true } : n));
    }
    return d;
  }, [plantQ.data, suggestQ.data, classKinds, pending]);
  const counts = countsOf(drawing);

  const [tab, setTab] = useState<Kind | null>(null);
  const firstTab = KINDS.find((k) => counts[k].total > counts[k].saved) ?? KINDS.find((k) => counts[k].total) ?? "chw_plant";
  const kind = tab ?? firstTab;
  const nodes = drawing[kind];

  // ── the open box ─────────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ id: string; top: number; left: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const place = useCallback((el: Element, id: string) => {
    const w = wrapRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!w) return;
    setError(null);
    setOpen({
      id,
      top: r.bottom - w.top + 8,
      left: Math.max(0, Math.min(r.left - w.left, w.width - POP_W)),
    });
  }, []);
  const openNode = useMemo(() => nodes.find((n) => n.id === open?.id) ?? null, [nodes, open]);

  // The deep link: open on the named equipment, on its own tab.
  const linked = useRef(initialEquipmentId);
  useEffect(() => {
    const id = linked.current;
    if (!id || !plantQ.data) return;
    const k = KINDS.find((x) => drawing[x].some((n) => n.id === `eq:${id}`));
    if (!k) return;
    if (k !== kind) {
      setTab(k);
      return;
    }
    const el = wrapRef.current?.querySelector(`[data-node="eq:${id}"]`);
    if (el) {
      linked.current = null;
      place(el, `eq:${id}`);
    }
  }, [plantQ.data, drawing, kind, place]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── live clock ───────────────────────────────────────────────────────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // ── writes ───────────────────────────────────────────────────────────────
  const refresh = useCallback(() => {
    const again = () => {
      qc.invalidateQueries({ queryKey: ["bi-plant-live", siteId] });
      qc.invalidateQueries({ queryKey: ["bi-equipment-suggestions", siteId] });
      qc.invalidateQueries({ queryKey: ["infra-tree", siteId] });
    };
    again();
    // The reporting mirror hears core a moment later.
    setTimeout(again, 2_500);
  }, [qc, siteId]);

  const madeSystems = useRef(new Map<Kind, string>());
  const save = useMutation({
    mutationFn: async (choices: SaveChoice[]) => {
      const k = choices[0].node.kind;
      let systemId =
        madeSystems.current.get(k) ?? treeQ.data?.systems.find((s) => s.kind === k)?.system_id ?? null;
      if (!systemId) {
        systemId = (await siteInfrastructure.createSystem(siteId, { name: SYSTEM_NAME[k], kind: k })).system_id;
        madeSystems.current.set(k, systemId);
      }
      let saved = 0;
      for (const c of choices) {
        await siteInfrastructure.createEquipment(siteId, {
          system_id: systemId,
          tag: c.node.label.trim().slice(0, 64),
          equipment_class: c.cls,
          slots: c.slots,
          fed_by_id: c.fedBy,
          design: c.design,
        });
        saved += 1;
        setPending((p) => new Set(p).add(c.node.label));
      }
      return saved;
    },
    onSuccess: (n) => {
      setOpen(null);
      toast.success(n === 1 ? "Saved" : `Saved ${n}`);
    },
    onError: (e) => setError(apiError(e, "Could not save it")),
    onSettled: refresh,
  });
  const feeder = useMutation({
    mutationFn: ({ id, fedBy }: { id: string; fedBy: string | null }) =>
      siteInfrastructure.updateEquipment(siteId, id, { fed_by_id: fedBy }),
    onError: (e) => setError(apiError(e, "Could not change what feeds it")),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => siteInfrastructure.deleteEquipment(siteId, id),
    onSuccess: () => {
      setOpen(null);
      toast.success("Removed");
    },
    onError: (e) => setError(apiError(e, "Could not remove it")),
    onSettled: refresh,
  });
  const republish = useMutation({
    mutationFn: () => siteInfrastructure.republish(siteId),
    onSuccess: (r) =>
      toast.success("Restated to analytics", {
        description: `${r.systems} system(s) and ${r.equipment} machine(s).`,
      }),
    onError: (e) => toast.error(apiError(e, "Could not restate this building's plant")),
  });
  const [importing, setImporting] = useState(initialImporting);
  const busy = save.isPending || feeder.isPending || remove.isPending;

  // Other clean proposals of the same type: what "Save all like this" saves.
  const likeOf = (n: Node) =>
    nodes.filter((o) => o.id !== n.id && !o.saved && o.cls === n.cls && !o.warn && !o.quiet && o.device);
  const saveAllLike = (c: SaveChoice) => {
    const allowed = new Set(ix.classes.get(c.cls)?.slots ?? []);
    const rest: SaveChoice[] = likeOf(c.node).map((o) => ({
      node: o,
      cls: c.cls,
      slots: (o.device?.slots ?? [])
        .filter((s) => !s.warning && allowed.has(s.slot))
        .map((s) => ({ slot: s.slot, device_tag: o.device?.device_tag ?? "", point_tag: s.point_tag })),
      fedBy: o.kind === "power" && o.parent?.startsWith("eq:") ? o.parent.slice(3) : null,
      design: {},
    }));
    save.mutate([c, ...rest]);
  };

  const feeders = drawing.power
    .filter((n) => n.equipment)
    .map((n) => ({ id: n.equipment!.equipment_id, label: n.label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const onPick = (e: MouseEvent<HTMLButtonElement>, n: Node) => {
    if (open?.id === n.id) setOpen(null);
    else place(e.currentTarget, n.id);
  };

  // ── render ───────────────────────────────────────────────────────────────
  const loadError = plantQ.error ?? suggestQ.error;
  const totals = suggestQ.data?.totals;
  const devices = suggestQ.data?.devices ?? [];
  const notMachines = devices.filter((d) => d.fragment);
  const unknown = devices.filter((d) => !d.fragment && !d.equipment_class);
  const unplaced = totals?.unplaced_elsewhere ?? 0;
  const openEquipment = openNode?.equipment
    ? treeQ.data?.systems.flatMap((s) => s.equipment).find((e) => e.equipment_id === openNode.equipment!.equipment_id)
    : undefined;

  const box = (n: Node) => (
    <NodeBox key={deviceOf(n) ?? n.id} node={n} active={open?.id === n.id} pending={pending.has(n.label) && !n.equipment} label={ix.classes.get(n.cls ?? "")?.label ?? null} still={still} onPick={onPick} />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* tabs · live · actions */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[.06] px-5 py-3">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => {
            const c = counts[k];
            const on = k === kind;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={on}
                type="button"
                onClick={() => {
                  setTab(k);
                  setOpen(null);
                }}
                className={`flex h-8 items-center gap-2 rounded-[9px] border px-3 text-[12.5px] transition ${
                  on
                    ? "border-nb-blue/60 bg-nb-blue/[.14] text-nb-ink"
                    : "border-white/[.08] text-nb-muted hover:border-white/[.18] hover:text-nb-soft"
                } ${c.total ? "" : "opacity-50"}`}
              >
                {KIND_LABEL[k]}
                <span className={`font-mono text-[11px] ${c.total && c.saved === c.total ? "text-nb-ok" : "text-nb-faint"}`}>
                  {c.saved}/{c.total}
                </span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {plantQ.dataUpdatedAt > 0 && (
            <span className="flex items-center gap-1.5 text-[11.5px] text-nb-faint">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-nb-ok opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-nb-ok" />
              </span>
              {agoLabel(now - plantQ.dataUpdatedAt)}
            </span>
          )}
          {mayWrite && (
            <>
              <IconButton icon="heroicons-outline:arrow-up-tray" title="Import I/O schedule" onClick={() => setImporting(true)} />
              <IconButton
                icon="heroicons-outline:arrow-path"
                title={republish.isPending ? "Restating…" : "Restate this building's plant to analytics"}
                disabled={republish.isPending}
                onClick={() => republish.mutate()}
              />
            </>
          )}
        </div>
      </div>

      {unplaced > 0 && (
        <Link
          href={taskHref("placement")}
          className="mx-5 mt-3 flex items-center gap-2 rounded-[10px] border border-nb-warn/30 bg-nb-warn/[.06] px-3.5 py-2 text-[12.5px] text-nb-soft transition hover:border-nb-warn/50"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-nb-warn" />
          {unplaced} device{unplaced === 1 ? " is" : "s are"} in no building yet — place them first and they show up here
          <span className="ml-auto text-nb-warn">Buildings →</span>
        </Link>
      )}

      {/* the drawing — the only thing that scrolls */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div ref={wrapRef} className="relative min-h-full px-5 py-5" data-testid="plant-drawing">
          {loadError ? (
            <p className="text-[12.5px] text-nb-crit">{apiError(loadError, "Could not read this building's plant")}</p>
          ) : plantQ.isLoading || suggestQ.isLoading ? (
            <p className="py-16 text-center text-[13px] text-nb-faint">Reading every device in the building…</p>
          ) : !nodes.length ? (
            <p className="py-16 text-center text-[13px] text-nb-faint">
              Nothing in this building looks like {KIND_LABEL[kind].toLowerCase()} equipment.
            </p>
          ) : kind === "power" ? (
            <PowerDrawing nodes={nodes} box={box} />
          ) : kind === "chw_plant" ? (
            <ChilledWaterDrawing nodes={nodes} box={box} ix={ix} />
          ) : (
            <Groups nodes={nodes} box={box} ix={ix} />
          )}

          {(notMachines.length > 0 || unknown.length > 0) && !loadError && (
            <div className="mt-8 flex flex-wrap gap-2 text-[11.5px] text-nb-faint">
              {unknown.length > 0 && (
                <span
                  title={unknown.map((d) => d.device_tag).join("\n")}
                  className="rounded-full border border-nb-warn/30 px-2.5 py-1 text-nb-warn"
                >
                  {unknown.length} not recognised
                </span>
              )}
              {notMachines.length > 0 && (
                <span title={notMachines.map((d) => d.device_tag).join("\n")} className="rounded-full border border-white/[.1] px-2.5 py-1">
                  {notMachines.length} not machines · old copies, the gateway
                </span>
              )}
            </div>
          )}

          <AnimatePresence>
            {openNode && open && (
              <div key={open.id} className="absolute z-30" style={{ top: open.top, left: open.left }}>
                <NodePopover
                  node={openNode}
                  vocab={vocab}
                  ix={ix}
                  feeders={feeders}
                  likeCount={openNode.saved ? 0 : likeOf(openNode).length}
                  mayWrite={mayWrite}
                  busy={busy}
                  error={error}
                  onSave={(c) => save.mutate([c])}
                  onSaveAllLike={saveAllLike}
                  onFeeder={(id, fedBy) => feeder.mutate({ id, fedBy })}
                  onRemove={(id) => remove.mutate(id)}
                  onClose={() => setOpen(null)}
                  nameplate={
                    openEquipment ? (
                      <div className="space-y-3">
                        <details className="group rounded-[10px] border border-white/[.07] px-3 py-2">
                          <summary className="cursor-pointer list-none text-[12px] text-nb-muted hover:text-nb-ink">
                            Change which point feeds a slot
                          </summary>
                          <div className="mt-2">
                            <SlotList
                              equipment={openEquipment}
                              defs={slotsOf(ix, ix.classes.get(openEquipment.equipment_class))}
                              mayWrite={mayWrite}
                            />
                          </div>
                        </details>
                        {factsOf(ix, ix.classes.get(openEquipment.equipment_class)).length > 0 && (
                          <DesignFacts
                            equipment={openEquipment}
                            facts={factsOf(ix, ix.classes.get(openEquipment.equipment_class))}
                            mayWrite={mayWrite}
                          />
                        )}
                      </div>
                    ) : null
                  }
                />
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {importing && mayWrite && <ScheduleImport siteId={siteId} ix={ix} onClose={() => setImporting(false)} />}
    </div>
  );
}

// ── one box ────────────────────────────────────────────────────────────────

function NodeBox({
  node,
  active,
  pending,
  label,
  still,
  onPick,
}: Readonly<{
  node: Node;
  active: boolean;
  pending: boolean;
  label: string | null;
  still: boolean;
  onPick: (e: MouseEvent<HTMLButtonElement>, n: Node) => void;
}>) {
  const solid = node.saved;
  return (
    <motion.button
      layout={!still}
      type="button"
      data-node={node.id}
      disabled={pending}
      aria-label={`${node.label}${solid ? "" : " — suggested"}`}
      aria-expanded={active}
      onClick={(e) => onPick(e, node)}
      initial={still ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: node.quiet ? 0.55 : 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className={`relative w-[196px] shrink-0 rounded-[10px] border px-3 py-2 text-left transition-colors ${
        solid
          ? "border-nb-blue/45 bg-[rgba(30,64,175,.16)]"
          : "border-dashed border-white/25 bg-transparent hover:border-nb-blue/60 hover:bg-nb-blue/[.05]"
      } ${active ? "ring-2 ring-nb-blue/60" : ""} ${pending ? "animate-pulse" : ""}`}
    >
      {node.warn && !solid && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-nb-warn" title="Something here looks off" />}
      <div className="truncate pr-3 text-[12.5px] font-medium text-nb-ink" title={node.label}>
        {node.label}
      </div>
      <div className={`mt-0.5 truncate text-[11px] ${label ? "text-nb-faint" : "text-nb-warn"}`}>
        {pending ? "saving…" : `${label ?? node.cls ?? "unknown type"}${solid ? "" : " ?"}`}
      </div>
      <div className="mt-1 h-4 truncate font-mono text-[11.5px] text-nb-blueb">{node.headline ?? ""}</div>
    </motion.button>
  );
}

type Box = (n: Node) => ReactNode;

// ── power: a single-line, left to right ────────────────────────────────────

function Branch({ tree, box }: Readonly<{ tree: Tree; box: Box }>) {
  return (
    <div className="flex items-start">
      {box(tree.node)}
      {tree.children.length > 0 && (
        <div className="flex items-start">
          <span className="mt-[34px] h-px w-5 bg-white/20" />
          <div className="flex flex-col gap-2 border-l border-white/20 py-[1px]">
            {tree.children.map((c) => (
              <div key={c.node.id} className="flex items-start">
                <span className="mt-[34px] h-px w-5 bg-white/20" />
                <Branch tree={c} box={box} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PowerDrawing({ nodes, box }: Readonly<{ nodes: Node[]; box: Box }>) {
  const { roots, loose } = chainOf(nodes);
  return (
    <div className="space-y-8">
      {roots.map((r) => (
        <div key={r.node.id} className="flex items-start gap-3">
          <div className="mt-[26px] flex flex-col items-center text-[10.5px] uppercase tracking-wider text-nb-faint">
            <span>grid</span>
            <span className="mt-1 h-px w-6 bg-white/25" />
          </div>
          <Branch tree={r} box={box} />
        </div>
      ))}
      {loose.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11.5px] text-nb-faint">Not hung under a feeder yet</h4>
          <div className="flex flex-wrap gap-2">{loose.map(box)}</div>
        </section>
      )}
    </div>
  );
}

// ── chilled water: the chillers between their headers, the rest below ─────

function ChilledWaterDrawing({ nodes, box, ix }: Readonly<{ nodes: Node[]; box: Box; ix: ReturnType<typeof indexVocabulary> }>) {
  const chillers = nodes.filter((n) => n.cls === "chiller");
  const rest = nodes.filter((n) => n.cls !== "chiller");
  return (
    <div className="space-y-8">
      {chillers.length > 0 && (
        <div className="inline-block min-w-full">
          <Header label="CHW supply" tone="bg-sky-400/50" />
          <div className="flex gap-3 overflow-visible py-3">
            {chillers.map((n) => (
              <div key={deviceOf(n) ?? n.id} className="flex flex-col items-center">
                <span className="h-3 w-px bg-sky-400/40" />
                {box(n)}
                <span className="h-3 w-px bg-orange-300/40" />
              </div>
            ))}
          </div>
          <Header label="CHW return" tone="bg-orange-300/50" />
        </div>
      )}
      {rest.length > 0 && <Groups nodes={rest} box={box} ix={ix} />}
    </div>
  );
}

function Header({ label, tone }: Readonly<{ label: string; tone: string }>) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10.5px] uppercase tracking-wider text-nb-faint">{label}</span>
      <span className={`h-[3px] flex-1 rounded-full ${tone}`} />
    </div>
  );
}

// ── anything else: grouped by type ─────────────────────────────────────────

function Groups({ nodes, box, ix }: Readonly<{ nodes: Node[]; box: Box; ix: ReturnType<typeof indexVocabulary> }>) {
  const by = new Map<string, Node[]>();
  for (const n of nodes) by.set(n.cls ?? "", [...(by.get(n.cls ?? "") ?? []), n]);
  return (
    <div className="space-y-6">
      {[...by.entries()].map(([cls, list]) => (
        <section key={cls}>
          <h4 className="mb-2 text-[11.5px] text-nb-faint">{ix.classes.get(cls)?.label ?? cls}</h4>
          <div className="flex flex-wrap gap-2">{list.sort((a, b) => a.label.localeCompare(b.label)).map(box)}</div>
        </section>
      ))}
    </div>
  );
}
