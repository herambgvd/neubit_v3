"use client";

// Create / edit a wall tour — a named, ordered sequence of presets the server
// cycles on a dwell interval. Pick presets (in order), set the dwell seconds.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Input, Modal } from "@/components/ui/kit";

export default function TourFormModal({ open, tour, presets = [], onClose, onSubmit, busy }: any) {
  const editing = !!tour;
  const [name, setName] = useState("");
  const [dwell, setDwell] = useState(10);
  const [selected, setSelected] = useState<any[]>([]); // ordered preset ids

  useEffect(() => {
    if (!open) return;
    setName(tour?.name || "");
    setDwell(tour?.dwell_seconds || 10);
    setSelected(tour?.preset_ids ? [...tour.preset_ids] : []);
  }, [open, tour]);

  if (!open) return null;

  const presetById = new Map<any, any>(presets.map((p) => [p.id, p]));
  const available = presets.filter((p) => !selected.includes(p.id));

  const add = (id) => setSelected((s) => [...s, id]);
  const remove = (id) => setSelected((s) => s.filter((x) => x !== id));
  const move = (idx, dir) =>
    setSelected((s) => {
      const j = idx + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const submit = () =>
    onSubmit?.({ name: name.trim(), preset_ids: selected, dwell_seconds: Number(dwell) });

  const valid = name.trim() && selected.length >= 1 && Number(dwell) >= 1;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit tour" : "New tour"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Saving…" : editing ? "Save" : "Create tour"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Perimeter sweep" autoFocus />
          <Input label="Dwell (seconds)" type="number" min={1} value={dwell} onChange={(e) => setDwell(e.target.value)} />
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Preset sequence</span>
          {selected.length === 0 ? (
            <p className="rounded-[8px] border border-dashed border-nb-line px-3 py-3 text-xs text-nb-faint">
              Add presets below — the tour cycles them in this order.
            </p>
          ) : (
            <ul className="space-y-1">
              {selected.map((id, idx) => (
                <li key={id} className="flex items-center gap-2 rounded-[8px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-1.5">
                  <span className="w-5 text-center font-mono text-[11px] tabular-nums text-nb-tealb">{idx + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-nb-ink">
                    {presetById.get(id)?.name || "(deleted preset)"}
                  </span>
                  <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} className="rounded-sm p-0.5 text-nb-soft hover:bg-[rgba(150,180,245,.07)] hover:text-nb-tealb disabled:opacity-30">
                    <Icon icon="heroicons-mini:chevron-up" className="text-xs" />
                  </button>
                  <button type="button" onClick={() => move(idx, 1)} disabled={idx === selected.length - 1} className="rounded-sm p-0.5 text-nb-soft hover:bg-[rgba(150,180,245,.07)] hover:text-nb-tealb disabled:opacity-30">
                    <Icon icon="heroicons-mini:chevron-down" className="text-xs" />
                  </button>
                  <button type="button" onClick={() => remove(id)} className="rounded-sm p-0.5 text-nb-soft hover:bg-[rgba(248,113,113,.1)] hover:text-nb-crit">
                    <Icon icon="heroicons-outline:x-mark" className="text-xs" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {available.length > 0 && (
          <div>
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Add preset</span>
            <div className="flex flex-wrap gap-1.5">
              {available.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => add(p.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-nb-line px-2 py-1 text-xs text-nb-ink transition hover:border-nb-teal hover:text-nb-tealb"
                >
                  <Icon icon="heroicons-mini:plus" className="text-[11px] text-nb-muted" />
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {presets.length === 0 && (
          <p className="text-[11px] text-nb-faint">Save some presets first — a tour cycles through presets.</p>
        )}
      </div>
    </Modal>
  );
}
