"use client";

// Visual SOP state-machine designer — orchestrator. Owns the states/transitions
// queries, the persistence mutations, the pointer interactions (node drag, pan,
// drag-to-connect, selection), and the modal wiring. Presentational pieces live
// alongside: CanvasToolbar, CanvasNode, CanvasEdge, StateModal, TransitionModal;
// pan/zoom viewport in hooks/usePanZoom; geometry in lib/canvasGeometry.
//
// Data contract (v3 backend): state {state_id,name,description,color,position_x,
// position_y,is_initial,is_terminal,is_cancellation,...}; transition {transition_id,
// from_state_id,to_state_id,label,requires_note,...}.
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, idOf } from "@/lib/format";
import { workflow as wfApi } from "../api";
import { NODE_W, NODE_H, nodeCenter } from "./lib/canvasGeometry";
import { usePanZoom } from "./hooks/usePanZoom";
import CanvasToolbar from "./CanvasToolbar";
import CanvasNode from "./CanvasNode";
import CanvasEdge, { PendingEdge } from "./CanvasEdge";
import StateModal from "./StateModal";
import TransitionModal from "./TransitionModal";

const sid = (s) => idOf(s, "state_id", "id");
const tid = (t) => idOf(t, "transition_id", "id");

export default function SopCanvas({ sopId }) {
  const qc = useQueryClient();
  const statesKey = ["wf-states", sopId];
  const transKey = ["wf-transitions", sopId];

  const statesQ = useQuery({ queryKey: statesKey, queryFn: () => wfApi.states.list(sopId, { limit: 200 }), enabled: !!sopId });
  const transQ = useQuery({ queryKey: transKey, queryFn: () => wfApi.transitions.list(sopId, { limit: 200 }), enabled: !!sopId });
  const states = useMemo(() => asItems(statesQ.data), [statesQ.data]);
  const transitions = useMemo(() => asItems(transQ.data), [transQ.data]);

  const { wrapRef, scale, offset, setOffset, size, screenToWorld, zoomBy, doFit } = usePanZoom(states);

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

  const stateById = useMemo(() => {
    const m = new Map();
    for (const s of states) {
      const dp = dragPos[sid(s)];
      m.set(sid(s), dp ? { ...s, position_x: dp.x, position_y: dp.y } : s);
    }
    return m;
  }, [states, dragPos]);
  const effStates = useMemo(() => Array.from(stateById.values()), [stateById]);

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
    [screenToWorld, wrapRef, setOffset],
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
    [screenToWorld, wrapRef],
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
      <CanvasToolbar
        scale={scale}
        onAddState={addState}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onFit={doFit}
      />

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
                <CanvasEdge
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
            <CanvasNode
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
