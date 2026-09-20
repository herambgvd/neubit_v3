"use client";

// One node, opened where it sits on the drawing.
//
// A PROPOSAL (dashed) opens as ONE question: is this what the platform thinks
// it is? The values each slot read are there, anything the checks flagged is
// there — a flagged slot starts UNTICKED, so the one reading that looked wrong
// is not saved by default — and, on the power chain, what feeds it. Save writes
// it through core. "Save all like this" saves every other clean proposal of the
// same type the same way.
//
// NOTHING off the machine's metal plate is asked for here. An operator confirming
// a device does not have the nameplate in front of them, and a capacity or a ΔT
// band typed from memory is worse than none. Those are asked later, one at a
// time, by NameplateWizard — where the band is OBSERVED from the readings and
// only confirmed.
//
// A SAVED node (solid) opens as what it is: its slots and their live values,
// what feeds it (changeable), and a way to remove it.
import { useMemo, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

import type { InfraVocabulary } from "@/lib/types";

import type { Node } from "./drawing";
import { classesForKind, type VocabIndex } from "./vocabulary";

export interface SaveChoice {
  node: Node;
  cls: string;
  slots: { slot: string; device_tag: string; point_tag: string }[];
  fedBy: string | null;
}

const fmtVal = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });

export default function NodePopover({
  node,
  vocab,
  ix,
  feeders,
  likeCount,
  mayWrite,
  busy,
  error,
  onSave,
  onSaveAllLike,
  onFeeder,
  onRemove,
  onClose,
  nameplate,
}: Readonly<{
  node: Node;
  vocab: InfraVocabulary;
  ix: VocabIndex;
  /** Saved equipment on the power chain, by id, that could feed this one. */
  feeders: { id: string; label: string }[];
  /** How many OTHER clean proposals share this one's type. */
  likeCount: number;
  mayWrite: boolean;
  busy: boolean;
  error: string | null;
  onSave: (c: SaveChoice) => void;
  onSaveAllLike: (c: SaveChoice) => void;
  onFeeder: (equipmentId: string, fedBy: string | null) => void;
  onRemove: (equipmentId: string) => void;
  onClose: () => void;
  /** A saved node's nameplate editor, drawn under its slots. */
  nameplate?: ReactNode;
}>) {
  const still = !!useReducedMotion();
  const d = node.device;
  const e = node.equipment;

  const [cls, setCls] = useState(node.cls ?? "");
  const allowed = useMemo(() => classesForKind(vocab, node.kind), [vocab, node.kind]);
  const classSlots = new Set(ix.classes.get(cls)?.slots ?? []);
  const [off, setOff] = useState<Set<string>>(
    () => new Set((d?.slots ?? []).filter((s) => s.warning).map((s) => s.slot)),
  );
  const suggestedFeeder = node.parent?.startsWith("eq:") ? node.parent.slice(3) : "";
  const [fedBy, setFedBy] = useState(suggestedFeeder);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function choice(): SaveChoice {
    return {
      node,
      cls,
      slots: (d?.slots ?? [])
        .filter((s) => !off.has(s.slot) && classSlots.has(s.slot))
        .map((s) => ({ slot: s.slot, device_tag: d?.device_tag ?? "", point_tag: s.point_tag })),
      fedBy: node.kind === "power" ? fedBy || null : null,
    };
  }

  const feederNote = (() => {
    if (node.kind !== "power" || !d?.feeder) return null;
    const f = d.feeder;
    if (f.suggested && !suggestedFeeder) return `${f.suggested} feeds it — save that one first`;
    if (!f.suggested && f.candidates.length > 1) return `${f.candidates.join(" or ")} — which one feeds it?`;
    return f.reason;
  })();

  return (
    <motion.div
      role="dialog"
      aria-label={node.label}
      initial={still ? false : { opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={still ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="w-[min(560px,calc(100vw-48px))] rounded-[14px] border border-nb-blue/45 bg-[#0e1a3c] p-4 shadow-[0_20px_50px_rgba(0,0,0,.5)]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-nb-ink">{node.label}</h3>
          <p className="mt-0.5 text-[12px] text-nb-muted">
            {node.saved ? `Saved · ${ix.classes.get(node.cls ?? "")?.label ?? node.cls}` : d?.why}
            {d?.quiet ? " · has stopped reporting" : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-[13px] text-nb-muted hover:text-nb-ink">
          ✕
        </button>
      </div>

      {d?.warnings.map((w) => (
        <p key={w} className="mt-2 text-[12px] text-nb-warn">
          {w}
        </p>
      ))}

      <div className="mt-3 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-[12.5px]">
        {!node.saved && (
          <>
            <label htmlFor="np-cls" className="text-nb-muted">It is a</label>
            <select
              id="np-cls"
              value={cls}
              disabled={!mayWrite}
              onChange={(ev) => setCls(ev.target.value)}
              className="h-8 rounded-[8px] border border-nb-blue/40 bg-transparent px-2 text-nb-blueb outline-none"
            >
              {allowed.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </>
        )}

        {node.kind === "power" && (
          <>
            <label htmlFor="np-feed" className="text-nb-muted">Fed by</label>
            <select
              id="np-feed"
              value={node.saved ? (e?.fed_by_id ?? "") : fedBy}
              disabled={!mayWrite || busy}
              onChange={(ev) =>
                node.saved && e ? onFeeder(e.equipment_id, ev.target.value || null) : setFedBy(ev.target.value)
              }
              className="h-8 rounded-[8px] border border-nb-blue/40 bg-transparent px-2 text-nb-blueb outline-none"
            >
              <option value="">nothing / not known</option>
              {feeders
                .filter((f) => f.id !== e?.equipment_id)
                .map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
            </select>
            {feederNote && !node.saved ? (
              <p className="col-start-2 -mt-1 text-[11.5px] text-nb-faint">{feederNote}</p>
            ) : null}
          </>
        )}
      </div>

      {/* the slots */}
      <div className="mt-3 overflow-hidden rounded-[10px] border border-white/[.07]">
        {node.saved
          ? (e?.slots ?? []).map((s) => (
              <div key={s.slot} className="grid grid-cols-[120px_1fr_90px] gap-3 border-t border-white/[.05] px-3 py-2 text-[12.5px] first:border-t-0">
                <span className="text-nb-muted">{ix.slots.get(s.slot)?.label ?? s.slot}</span>
                <span className="truncate font-mono text-[11.5px] text-nb-blueb">{s.binding?.point_tag ?? "not bound"}</span>
                <span className="text-right tabular-nums text-nb-ink">{fmtVal(s.latest?.value)}</span>
              </div>
            ))
          : (d?.slots ?? []).map((s) => {
              const fits = classSlots.has(s.slot);
              return (
                <label
                  key={s.slot}
                  className={`grid grid-cols-[18px_110px_1fr_80px] items-center gap-3 border-t border-white/[.05] px-3 py-2 text-[12.5px] first:border-t-0 ${
                    s.warning ? "bg-nb-warn/[.05]" : ""
                  } ${fits ? "" : "opacity-40"}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Save ${s.slot}`}
                    checked={fits && !off.has(s.slot)}
                    disabled={!fits || !mayWrite}
                    onChange={(ev) =>
                      setOff((prev) => {
                        const next = new Set(prev);
                        if (ev.target.checked) next.delete(s.slot);
                        else next.add(s.slot);
                        return next;
                      })
                    }
                    className="accent-[#4ea3ff]"
                  />
                  <span className={s.warning ? "text-nb-warn" : "text-nb-muted"}>
                    {ix.slots.get(s.slot)?.label ?? s.slot}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-nb-blueb" title={s.point_tag}>
                    {s.point_tag}
                    {s.alternatives ? <span className="text-nb-faint"> · +{s.alternatives} older</span> : null}
                  </span>
                  <span className={`text-right tabular-nums ${s.warning ? "text-nb-warn" : "text-nb-ink"}`}>
                    {fmtVal(s.value)}
                  </span>
                  {s.warning ? (
                    <span className="col-span-4 -mt-1 pl-[30px] text-[11.5px] text-nb-warn">{s.warning}</span>
                  ) : null}
                </label>
              );
            })}
        {!node.saved && !(d?.slots ?? []).length ? (
          <p className="px-3 py-2 text-[12px] text-nb-faint">No value on it matches a slot of this type.</p>
        ) : null}
      </div>

      {node.saved && nameplate ? <div className="mt-3">{nameplate}</div> : null}

      {error && <p className="mt-3 text-[12px] text-nb-crit">{error}</p>}

      {mayWrite && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!node.saved ? (
            <>
              <button
                type="button"
                disabled={busy || !cls}
                onClick={() => onSave(choice())}
                className="h-9 rounded-[9px] bg-nb-blue px-4 text-[13px] font-medium text-white transition hover:bg-nb-blueb disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {likeCount > 0 && (
                <button
                  type="button"
                  disabled={busy || !cls}
                  onClick={() => onSaveAllLike(choice())}
                  className="h-9 rounded-[9px] border border-white/[.14] px-3.5 text-[13px] text-nb-soft transition hover:border-nb-blue/50 hover:text-nb-ink disabled:opacity-50"
                >
                  Save all {likeCount + 1} like this
                </button>
              )}
            </>
          ) : confirmRemove ? (
            <>
              <span className="text-[12.5px] text-nb-soft">Remove {node.label} from the registry?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => e && onRemove(e.equipment_id)}
                className="h-9 rounded-[9px] bg-[#b91c1c] px-3.5 text-[12.5px] font-medium text-white hover:bg-[#dc2626] disabled:opacity-50"
              >
                Remove
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)} className="h-9 px-3 text-[12.5px] text-nb-muted hover:text-nb-ink">
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="text-[12px] text-nb-faint transition hover:text-nb-crit"
            >
              Remove from the registry
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}
