"use client";

// Visual SOP state-machine designer — ported from neubit_v2's canvas SOP builder
// (components/workflow/sop-builder/*) but re-implemented as an SVG/DOM canvas so it
// themes cleanly with neubit_v3's semantic tokens and supports drag-to-connect handles.
//
// Structure:
//   • Background: a themed dotted grid inside a pannable/zoomable viewport.
//   • Nodes: absolutely-positioned DOM cards (world coords → screen via the transform).
//       Each state renders name, a left color accent (state.color), and Initial/Terminal/
//       Cancellation badges. Nodes are draggable; on drop we PATCH position_x/position_y.
//   • Edges: a single full-canvas <svg> painting curved bezier transitions with an
//       arrowhead + a label chip at the curve midpoint (from_state → to_state).
//   • Connect: each node has a right-edge handle; drag it to a target node to create a
//       transition (opens a small modal for label + requires_note).
//   • Pan: drag the empty background. Zoom: mouse wheel (anchored to cursor) + toolbar.
//   • Fit/reset: toolbar button re-frames all nodes.
//
// Data contract (v3 backend): state {state_id,name,description,color,position_x,
// position_y,is_initial,is_terminal,is_cancellation,...}; transition {transition_id,
// from_state_id,to_state_id,label,requires_note,...}.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Modal, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "../api";

const NODE_W = 190;
const NODE_H = 76;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.5;
const DEFAULT_COLOR = "#6366F1";

const asItems = (d) => (Array.isArray(d) ? d : d?.items || []);
const idOf = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v != null);
const sid = (s) => idOf(s, "state_id", "id");
const tid = (t) => idOf(t, "transition_id", "id");

const nodeCenter = (s) => ({
  x: (s.position_x ?? 0) + NODE_W / 2,
  y: (s.position_y ?? 0) + NODE_H / 2,
});

// Bezier control points between two node centers — mirrors v2's transitionGeometry
// (drops a little so parallel edges separate and the curve reads as directional).
function edgePath(from, to) {
  const a = nodeCenter(from);
  const b = nodeCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ox = dx * 0.3;
  const oy = dy * 0.3;
  const c1 = { x: a.x + ox, y: a.y + oy + 30 };
  const c2 = { x: b.x - ox, y: b.y - oy - 30 };
  return { a, b, c1, c2 };
}

// Point at t on the cubic bezier (for label placement + arrowhead angle).
function bezierPoint(a, c1, c2, b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

function computeFit(states, w, h) {
  if (!states.length || !w || !h) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of states) {
    const x = s.position_x ?? 0;
    const y = s.position_y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  }
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const scale = Math.max(MIN_SCALE, Math.min((w - 100) / bw, (h - 100) / bh, 1.2));
  return {
    scale,
    offset: {
      x: (w - bw * scale) / 2 - minX * scale,
      y: (h - bh * scale) / 2 - minY * scale,
    },
  };
}

export default function SopCanvas({ sopId }) {
  const qc = useQueryClient();
  const statesKey = ["wf-states", sopId];
  const transKey = ["wf-transitions", sopId];

  const statesQ = useQuery({ queryKey: statesKey, queryFn: () => wfApi.states.list(sopId, { limit: 200 }), enabled: !!sopId });
  const transQ = useQuery({ queryKey: transKey, queryFn: () => wfApi.transitions.list(sopId, { limit: 200 }), enabled: !!sopId });
  const states = useMemo(() => asItems(statesQ.data), [statesQ.data]);
  const transitions = useMemo(() => asItems(transQ.data), [transQ.data]);

  const wrapRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 40, y: 40 });
  const [size, setSize] = useState({ w: 0, h: 0 });

  const [selection, setSelection] = useState(null); // { kind: "state"|"transition", id }
  const [stateModal, setStateModal] = useState(null); // state obj or {} (new)
  const [transModal, setTransModal] = useState(null); // { from, to } (new) or transition obj (edit)
  const [confirm, setConfirm] = useState(null);

  // Live drag overrides so we don't mutate query data mid-drag.
  const [dragPos, setDragPos] = useState({}); // { [state_id]: {x,y} }
  const dragRef = useRef(null); // { id, startWorld, orig, moved }
  const panRef = useRef(null); // { x, y, ox, oy }
  const [panning, setPanning] = useState(false);
  const connectRef = useRef(null); // { fromId }
  const [connect, setConnect] = useState(null); // { fromId, x, y } world coords of cursor
  const didFitRef = useRef(false);

  const stateById = useMemo(() => {
    const m = new Map();
    for (const s of states) {
      const dp = dragPos[sid(s)];
      m.set(sid(s), dp ? { ...s, position_x: dp.x, position_y: dp.y } : s);
    }
    return m;
  }, [states, dragPos]);
  const effStates = useMemo(() => Array.from(stateById.values()), [stateById]);

  /* ── measure container ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* ── auto-fit once states first load ── */
  useEffect(() => {
    if (didFitRef.current || !states.length || !size.w) return;
    const fit = computeFit(states, size.w, size.h);
    if (fit) {
      setScale(fit.scale);
      setOffset(fit.offset);
      didFitRef.current = true;
    }
  }, [states, size]);

  const doFit = useCallback(() => {
    const fit = computeFit(states, size.w, size.h);
    if (fit) {
      setScale(fit.scale);
      setOffset(fit.offset);
    } else {
      setScale(1);
      setOffset({ x: 40, y: 40 });
    }
  }, [states, size]);

  const screenToWorld = useCallback(
    (sx, sy) => ({ x: (sx - offset.x) / scale, y: (sy - offset.y) / scale }),
    [offset, scale],
  );

  /* ── wheel zoom (non-passive, anchored to cursor) ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScale((prev) => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
        setOffset((off) => {
          const wx = (mx - off.x) / prev;
          const wy = (my - off.y) / prev;
          return { x: mx - wx * next, y: my - wy * next };
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = useCallback(
    (factor) => {
      const cx = size.w / 2;
      const cy = size.h / 2;
      setScale((prev) => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
        setOffset((off) => {
          const wx = (cx - off.x) / prev;
          const wy = (cy - off.y) / prev;
          return { x: cx - wx * next, y: cy - wy * next };
        });
        return next;
      });
    },
    [size],
  );

  /* ── persistence mutations ── */
  const moveState = useMutation({
    mutationFn: ({ id, x, y }) => wfApi.states.update(sopId, id, { position_x: x, position_y: y }),
    onSuccess: () => qc.invalidateQueries({ queryKey: statesKey }),
    onError: (e) => toast.error(apiError(e)),
  });
  const removeState = useMutation({
    mutationFn: (id) => wfApi.states.remove(sopId, id),
    onSuccess: () => {
      toast.success("State removed");
      qc.invalidateQueries({ queryKey: statesKey });
      qc.invalidateQueries({ queryKey: transKey });
      setSelection(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const removeTransition = useMutation({
    mutationFn: (id) => wfApi.transitions.remove(sopId, id),
    onSuccess: () => {
      toast.success("Transition removed");
      qc.invalidateQueries({ queryKey: transKey });
      setSelection(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  /* ── add a state at a sensible default position (screen center → world) ── */
  const addState = useCallback(() => {
    const cx = (size.w / 2 - offset.x) / scale - NODE_W / 2;
    const cy = (size.h / 2 - offset.y) / scale - NODE_H / 2;
    // Stagger slightly so successive adds don't stack exactly.
    const jitter = (states.length % 5) * 26;
    setStateModal({ position_x: Math.round(cx + jitter), position_y: Math.round(cy + jitter) });
  }, [size, offset, scale, states.length]);

  /* ── background pointer: pan / clear selection / finish a connect drag ── */
  const onBgPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      // Only fires when the empty background is hit (nodes stop propagation).
      setSelection(null);
      setPanning(true);
      panRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    },
    [offset],
  );

  const onWrapPointerMove = useCallback(
    (e) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      if (dragRef.current) {
        const d = dragRef.current;
        const nx = d.orig.x + (w.x - d.startWorld.x);
        const ny = d.orig.y + (w.y - d.startWorld.y);
        if (Math.abs(nx - d.orig.x) > 1 || Math.abs(ny - d.orig.y) > 1) d.moved = true;
        setDragPos((p) => ({ ...p, [d.id]: { x: nx, y: ny } }));
        return;
      }
      if (connectRef.current) {
        setConnect({ fromId: connectRef.current.fromId, x: w.x, y: w.y });
        return;
      }
      if (panRef.current) {
        setOffset({
          x: panRef.current.ox + (e.clientX - panRef.current.x),
          y: panRef.current.oy + (e.clientY - panRef.current.y),
        });
      }
    },
    [screenToWorld],
  );

  const endInteractions = useCallback(() => {
    if (dragRef.current) {
      const d = dragRef.current;
      if (d.moved) {
        const pos = dragPos[d.id];
        if (pos) moveState.mutate({ id: d.id, x: Math.round(pos.x), y: Math.round(pos.y) });
      }
      // Clear the local override after the query refetch lands.
      const id = d.id;
      setTimeout(() => setDragPos((p) => { const n = { ...p }; delete n[id]; return n; }), 700);
      dragRef.current = null;
    }
    connectRef.current = null;
    setConnect(null);
    panRef.current = null;
    setPanning(false);
  }, [dragPos, moveState]);

  /* ── node interactions ── */
  const onNodePointerDown = useCallback(
    (e, s) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      setSelection({ kind: "state", id: sid(s) });
      dragRef.current = {
        id: sid(s),
        startWorld: w,
        orig: { x: s.position_x ?? 0, y: s.position_y ?? 0 },
        moved: false,
      };
    },
    [screenToWorld],
  );

  const onHandlePointerDown = useCallback((e, s) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    connectRef.current = { fromId: sid(s) };
    setConnect({ fromId: sid(s), x: nodeCenter(s).x, y: nodeCenter(s).y });
  }, []);

  const onNodePointerUp = useCallback((e, s) => {
    if (connectRef.current && connectRef.current.fromId !== sid(s)) {
      e.stopPropagation();
      const fromId = connectRef.current.fromId;
      connectRef.current = null;
      setConnect(null);
      setTransModal({ from_state_id: fromId, to_state_id: sid(s) });
    }
  }, []);

  const busy = statesQ.isLoading || transQ.isLoading;
  const connectFrom = connect ? stateById.get(connect.fromId) : null;

  return (
    <div className="rounded-xl border border-card-border bg-card overflow-hidden flex flex-col" style={{ height: "clamp(440px, 64vh, 760px)" }}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border px-3 py-2 bg-card">
        <Button variant="success" icon="heroicons-outline:plus" onClick={addState} className="!px-2.5 !py-1 text-xs">
          Add state
        </Button>
        <span className="text-[11px] text-muted hidden sm:inline">
          Drag a node to move · drag the <Icon icon="heroicons-outline:arrow-right-circle" className="inline align-[-2px] text-xs" /> handle to connect
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ToolBtn icon="heroicons-outline:minus" title="Zoom out" onClick={() => zoomBy(1 / 1.2)} />
          <span className="text-[11px] text-muted w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <ToolBtn icon="heroicons-outline:plus" title="Zoom in" onClick={() => zoomBy(1.2)} />
          <ToolBtn icon="heroicons-outline:viewfinder-circle" title="Fit to view" onClick={doFit} />
        </div>
      </div>

      {/* Canvas viewport */}
      <div
        ref={wrapRef}
        onPointerDown={onBgPointerDown}
        onPointerMove={onWrapPointerMove}
        onPointerUp={endInteractions}
        onPointerLeave={endInteractions}
        className="relative flex-1 min-h-0 overflow-hidden select-none"
        style={{
          cursor: panning ? "grabbing" : connect ? "crosshair" : "grab",
          backgroundColor: "var(--hover)",
          backgroundImage: "radial-gradient(var(--card-border) 1px, transparent 1px)",
          backgroundSize: `${24 * scale}px ${24 * scale}px`,
          backgroundPosition: `${offset.x}px ${offset.y}px`,
        }}
      >
        {/* Edges layer (SVG, full canvas, world→screen via the outer transform) */}
        <svg className="absolute inset-0 h-full w-full pointer-events-none" style={{ overflow: "visible" }}>
          <g transform={`translate(${offset.x},${offset.y}) scale(${scale})`}>
            {transitions.map((t) => {
              const from = stateById.get(t.from_state_id);
              const to = stateById.get(t.to_state_id);
              if (!from || !to) return null;
              const isSel = selection?.kind === "transition" && selection.id === tid(t);
              return (
                <Edge
                  key={tid(t)}
                  from={from}
                  to={to}
                  label={t.label}
                  selected={isSel}
                  onSelect={() => setSelection({ kind: "transition", id: tid(t) })}
                  onEdit={() => setTransModal(t)}
                />
              );
            })}
            {/* Pending connect line */}
            {connect && connectFrom && (
              <PendingEdge from={connectFrom} to={connect} />
            )}
          </g>
        </svg>

        {/* Node layer (DOM) */}
        <div
          className="absolute inset-0"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: "0 0" }}
        >
          {effStates.map((s) => (
            <StateNode
              key={sid(s)}
              state={s}
              selected={selection?.kind === "state" && selection.id === sid(s)}
              onPointerDown={(e) => onNodePointerDown(e, s)}
              onPointerUp={(e) => onNodePointerUp(e, s)}
              onHandleDown={(e) => onHandlePointerDown(e, s)}
              onEdit={() => setStateModal(s)}
            />
          ))}
        </div>

        {/* Overlays */}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="inline-flex items-center gap-2 rounded-md bg-card/80 px-3 py-1.5 text-xs text-muted border border-card-border">
              <Spinner className="!h-4 !w-4" /> Loading…
            </span>
          </div>
        )}
        {!busy && states.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none px-6">
            <Icon icon="heroicons-outline:squares-plus" className="text-3xl text-muted opacity-60" />
            <p className="mt-2 text-sm font-medium text-foreground">No states yet</p>
            <p className="mt-1 text-xs text-muted">
              Click <b className="text-foreground">Add state</b> to place the first node of this workflow.
            </p>
          </div>
        )}

        {/* Selection action bar */}
        {selection && (
          <SelectionBar
            selection={selection}
            states={stateById}
            transitions={transitions}
            onEdit={() => {
              if (selection.kind === "state") {
                const s = stateById.get(selection.id);
                if (s) setStateModal(s);
              } else {
                const t = transitions.find((x) => tid(x) === selection.id);
                if (t) setTransModal(t);
              }
            }}
            onDelete={() => {
              if (selection.kind === "state") {
                const s = stateById.get(selection.id);
                setConfirm({
                  title: "Delete state?",
                  message: `Delete "${s?.name}" and any transitions touching it?`,
                  confirmLabel: "Delete",
                  onConfirm: () => { removeState.mutate(selection.id); setConfirm(null); },
                });
              } else {
                const t = transitions.find((x) => tid(x) === selection.id);
                setConfirm({
                  title: "Delete transition?",
                  message: `Delete "${t?.label || "this transition"}"?`,
                  confirmLabel: "Delete",
                  onConfirm: () => { removeTransition.mutate(selection.id); setConfirm(null); },
                });
              }
            }}
          />
        )}
      </div>

      {stateModal && (
        <StateModal
          sopId={sopId}
          state={sid(stateModal) ? stateModal : null}
          defaults={stateModal}
          onClose={() => setStateModal(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: statesKey }); setStateModal(null); }}
        />
      )}
      {transModal && (
        <TransitionModal
          sopId={sopId}
          states={effStates}
          transition={tid(transModal) ? transModal : null}
          defaults={transModal}
          onClose={() => setTransModal(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: transKey }); setTransModal(null); }}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={removeState.isPending || removeTransition.isPending} />
    </div>
  );
}

/* ── small toolbar icon button ── */
function ToolBtn({ icon, title, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border bg-card text-muted hover:bg-hover hover:text-foreground transition"
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}

/* ── a draggable state node card ── */
function StateNode({ state, selected, onPointerDown, onPointerUp, onHandleDown, onEdit }) {
  const color = state.color || DEFAULT_COLOR;
  const badges = [];
  if (state.is_initial) badges.push(["Initial", "heroicons-solid:play", "#10b981"]);
  if (state.is_terminal) badges.push(["Terminal", "heroicons-solid:stop", "#64748b"]);
  if (state.is_cancellation) badges.push(["Cancel", "heroicons-solid:x-circle", "#ef4444"]);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}
      className="absolute rounded-xl border bg-card shadow-sm transition-shadow"
      style={{
        left: state.position_x ?? 0,
        top: state.position_y ?? 0,
        width: NODE_W,
        minHeight: NODE_H,
        cursor: "grab",
        borderColor: selected ? color : "var(--card-border)",
        boxShadow: selected ? `0 0 0 2px ${color}55, 0 6px 18px rgba(0,0,0,0.14)` : "0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      {/* color accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-xl" style={{ backgroundColor: color }} />
      <div className="pl-4 pr-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-1 h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm font-semibold text-foreground leading-snug break-words">{state.name || "Untitled"}</span>
        </div>
        {badges.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {badges.map(([label, icon, c]) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${c}1a`, color: c }}
              >
                <Icon icon={icon} className="text-[11px]" /> {label}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* connect handle (right edge) */}
      <button
        type="button"
        title="Drag to connect"
        onPointerDown={onHandleDown}
        className="absolute -right-2.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full border-2 border-card bg-card text-muted hover:text-foreground flex items-center justify-center shadow"
        style={{ cursor: "crosshair", color }}
      >
        <Icon icon="heroicons-solid:plus" className="text-[11px]" />
      </button>
    </div>
  );
}

/* ── a transition edge (bezier + arrowhead + label chip) ── */
function Edge({ from, to, label, selected, onSelect, onEdit }) {
  const { a, b, c1, c2 } = edgePath(from, to);
  const d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
  const mid = bezierPoint(a, c1, c2, b, 0.5);
  // Arrowhead: end tangent from c2→b.
  const ang = Math.atan2(b.y - c2.y, b.x - c2.x);
  const ah = 11;
  const stroke = selected ? "var(--foreground)" : "var(--muted)";
  const p1 = { x: b.x - Math.cos(ang - Math.PI / 7) * ah, y: b.y - Math.sin(ang - Math.PI / 7) * ah };
  const p2 = { x: b.x - Math.cos(ang + Math.PI / 7) * ah, y: b.y - Math.sin(ang + Math.PI / 7) * ah };
  const charW = 6.4;
  const chipW = Math.max(28, (label || "").length * charW + 16);

  return (
    <g className="pointer-events-auto" style={{ cursor: "pointer" }}
       onPointerDown={(e) => { e.stopPropagation(); onSelect(); }}
       onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
      {/* fat invisible hit area */}
      <path d={d} stroke="transparent" strokeWidth={14} fill="none" />
      <path d={d} stroke={stroke} strokeWidth={selected ? 2.5 : 2} fill="none" />
      <path d={`M ${b.x} ${b.y} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} Z`} fill={stroke} />
      {label && (
        <>
          <rect
            x={mid.x - chipW / 2}
            y={mid.y - 11}
            width={chipW}
            height={22}
            rx={11}
            fill="var(--card)"
            stroke={selected ? "var(--foreground)" : "var(--card-border)"}
          />
          <text x={mid.x} y={mid.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="var(--foreground)">
            {label}
          </text>
        </>
      )}
    </g>
  );
}

function PendingEdge({ from, to }) {
  const a = nodeCenter(from);
  const dx = to.x - a.x;
  const dy = to.y - a.y;
  const c1 = { x: a.x + dx * 0.3, y: a.y + dy * 0.3 + 30 };
  const c2 = { x: to.x - dx * 0.3, y: to.y - dy * 0.3 - 30 };
  const d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
  return <path d={d} stroke="var(--foreground)" strokeWidth={2} strokeDasharray="5 4" fill="none" opacity={0.7} />;
}

/* ── floating action bar for the current selection ── */
function SelectionBar({ selection, states, transitions, onEdit, onDelete }) {
  let title = "";
  if (selection.kind === "state") title = states.get(selection.id)?.name || "State";
  else title = transitions.find((t) => tid(t) === selection.id)?.label || "Transition";
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-lg border border-card-border bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur">
      <span className="px-1.5 text-xs text-muted max-w-[180px] truncate">
        {selection.kind === "state" ? "State" : "Transition"}: <span className="text-foreground font-medium">{title}</span>
      </span>
      <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-xs text-foreground hover:bg-hover">
        <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
      </button>
      <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-500 hover:bg-red-500/20">
        <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
      </button>
    </div>
  );
}

/* ════════════════════════════ modals ════════════════════════════ */
const FLD = "mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted";
const LBL = "text-xs font-medium uppercase tracking-wide text-muted";
const STATE_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#EF4444", "#3B82F6", "#8B5CF6", "#EC4899", "#64748B"];

function StateModal({ sopId, state, defaults, onClose, onSaved }) {
  const isEdit = !!state;
  const [name, setName] = useState(state?.name || "");
  const [description, setDescription] = useState(state?.description || "");
  const [color, setColor] = useState(state?.color || DEFAULT_COLOR);
  const [isInitial, setIsInitial] = useState(!!state?.is_initial);
  const [isTerminal, setIsTerminal] = useState(!!state?.is_terminal);
  const [isCancellation, setIsCancellation] = useState(!!state?.is_cancellation);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.states.update(sopId, sid(state), body) : wfApi.states.create(sopId, body)),
    onSuccess: () => { toast.success(isEdit ? "State updated" : "State created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    if (!name.trim()) { setErr("Name is required"); return; }
    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      color,
      is_initial: isInitial,
      is_terminal: isTerminal,
      is_cancellation: isCancellation,
      position_x: state?.position_x ?? defaults?.position_x ?? 40,
      position_y: state?.position_y ?? defaults?.position_y ?? 40,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit state · ${state.name}` : "Add state"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add state"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={LBL}>Name <span className="text-red-500">*</span></label>
          <input autoFocus value={name} onChange={(e) => { setName(e.target.value); if (err) setErr(""); }} className={`${FLD} ${err ? "!border-red-500" : ""}`} placeholder="e.g. Acknowledged" />
          {err && <p className="mt-1 text-xs text-red-500">{err}</p>}
        </div>
        <div>
          <label className={LBL}>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={FLD} placeholder="Optional" />
        </div>
        <div>
          <label className={LBL}>Color</label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {STATE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="h-7 w-7 rounded-full border-2 transition"
                style={{ backgroundColor: c, borderColor: color === c ? "var(--foreground)" : "transparent" }}
                title={c}
              />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 rounded border border-card-border bg-transparent cursor-pointer" title="Custom color" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isInitial} onChange={(e) => setIsInitial(e.target.checked)} /> Initial</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isTerminal} onChange={(e) => setIsTerminal(e.target.checked)} /> Terminal</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isCancellation} onChange={(e) => setIsCancellation(e.target.checked)} /> Cancellation</label>
        </div>
      </div>
    </Modal>
  );
}

function TransitionModal({ sopId, states, transition, defaults, onClose, onSaved }) {
  const isEdit = !!transition;
  const [label, setLabel] = useState(transition?.label || "");
  const [description, setDescription] = useState(transition?.description || "");
  const [fromId, setFromId] = useState(transition?.from_state_id ?? defaults?.from_state_id ?? "");
  const [toId, setToId] = useState(transition?.to_state_id ?? defaults?.to_state_id ?? "");
  const [requiresNote, setRequiresNote] = useState(!!transition?.requires_note);
  const [confirmationRequired, setConfirmationRequired] = useState(!!transition?.confirmation_required);
  const [errors, setErrors] = useState({});

  const save = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.transitions.update(sopId, tid(transition), body) : wfApi.transitions.create(sopId, body)),
    onSuccess: () => { toast.success(isEdit ? "Transition updated" : "Transition created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    const next = {};
    if (!label.trim()) next.label = "Label is required";
    if (!fromId) next.fromId = "From state required";
    if (!toId) next.toId = "To state required";
    if (Object.keys(next).length) { setErrors(next); return; }
    save.mutate({
      label: label.trim(),
      description: description.trim() || null,
      from_state_id: fromId,
      to_state_id: toId,
      requires_note: requiresNote,
      confirmation_required: confirmationRequired,
    });
  }

  const opts = states.map((s) => ({ id: sid(s), name: s.name }));

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit transition · ${transition.label}` : "Add transition"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add transition"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={LBL}>Label <span className="text-red-500">*</span></label>
          <input autoFocus value={label} onChange={(e) => { setLabel(e.target.value); if (errors.label) setErrors((p) => ({ ...p, label: undefined })); }} className={`${FLD} ${errors.label ? "!border-red-500" : ""}`} placeholder="e.g. Acknowledge" />
          {errors.label && <p className="mt-1 text-xs text-red-500">{errors.label}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LBL}>From <span className="text-red-500">*</span></label>
            <select value={fromId} onChange={(e) => { setFromId(e.target.value); if (errors.fromId) setErrors((p) => ({ ...p, fromId: undefined })); }} className={`${FLD} ${errors.fromId ? "!border-red-500" : ""}`}>
              <option value="" className="bg-card">Select…</option>
              {opts.map((o) => <option key={o.id} value={o.id} className="bg-card">{o.name}</option>)}
            </select>
            {errors.fromId && <p className="mt-1 text-xs text-red-500">{errors.fromId}</p>}
          </div>
          <div>
            <label className={LBL}>To <span className="text-red-500">*</span></label>
            <select value={toId} onChange={(e) => { setToId(e.target.value); if (errors.toId) setErrors((p) => ({ ...p, toId: undefined })); }} className={`${FLD} ${errors.toId ? "!border-red-500" : ""}`}>
              <option value="" className="bg-card">Select…</option>
              {opts.map((o) => <option key={o.id} value={o.id} className="bg-card">{o.name}</option>)}
            </select>
            {errors.toId && <p className="mt-1 text-xs text-red-500">{errors.toId}</p>}
          </div>
        </div>
        <div>
          <label className={LBL}>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={FLD} placeholder="Optional" />
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={requiresNote} onChange={(e) => setRequiresNote(e.target.checked)} /> Requires note</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={confirmationRequired} onChange={(e) => setConfirmationRequired(e.target.checked)} /> Confirmation required</label>
        </div>
      </div>
    </Modal>
  );
}
