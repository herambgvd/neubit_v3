"use client";

// Create / edit a video wall — name, description, optional site, and the
// MONITOR grid (rows × cols). The grid defines how many monitors tile the wall;
// monitors are added/positioned separately (in the Monitors tab).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button, Input, Modal, Select, Textarea, Toggle } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";

import type { WallCreate, WallPublic } from "../types";

const GRID_OPTS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }));

/** The edit buffer. `rows`/`cols` hold the Select's raw string until submit
 *  coerces them, so both shapes are allowed here. */
interface WallForm {
  name: string;
  description: string;
  site_id: string;
  rows: number | string;
  cols: number | string;
  is_active: boolean;
}

export interface WallFormModalProps {
  open: boolean;
  /** The wall being edited, or null/undefined to create one. */
  wall?: WallPublic | null;
  onClose: () => void;
  onSubmit?: (body: WallCreate) => void;
  busy?: boolean;
}

export default function WallFormModal({ open, wall, onClose, onSubmit, busy }: WallFormModalProps) {
  const editing = !!wall;
  const [form, setForm] = useState<WallForm | null>(null);

  const sitesQ = useQuery({
    queryKey: ["sites-list", "wall-form"],
    queryFn: () => sitesApi.list({ limit: 500 }),
    enabled: open,
    staleTime: 60_000,
  });
  const siteOpts = useMemo(
    // `site_id`, not `id`: SitePublic keys its identifier `site_id`, so the old
    // `s.id` put `undefined` in every option value and the picked site was never
    // sent with the wall.
    () => [
      { value: "", label: "No site" },
      ...asItems(sitesQ.data).map((s) => ({ value: s.site_id, label: s.name })),
    ],
    [sitesQ.data],
  );

  useEffect(() => {
    if (!open) return;
    setForm({
      name: wall?.name || "",
      description: wall?.description || "",
      site_id: wall?.site_id || "",
      rows: wall?.rows || 2,
      cols: wall?.cols || 2,
      is_active: wall?.is_active ?? true,
    });
  }, [open, wall]);

  if (!open || !form) return null;

  const set = <K extends keyof WallForm>(k: K, v: WallForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const submit = () => {
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      site_id: form.site_id || null,
      rows: Number(form.rows),
      cols: Number(form.cols),
      is_active: form.is_active,
    };
    onSubmit?.(body);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit wall" : "New video wall"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!form.name.trim() || busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create wall"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Main control room" autoFocus />
        <Textarea
          label="Description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Optional"
          rows={2}
        />
        <Select label="Site" options={siteOpts} value={form.site_id} onChange={(e) => set("site_id", e.target.value)} placeholder="No site" />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Monitor rows" options={GRID_OPTS} value={String(form.rows)} onChange={(e) => set("rows", e.target.value)} />
          <Select label="Monitor columns" options={GRID_OPTS} value={String(form.cols)} onChange={(e) => set("cols", e.target.value)} />
        </div>
        <p className="text-xs text-nb-soft">
          Wall grid: {form.rows} × {form.cols} = {Number(form.rows) * Number(form.cols)} monitor slots. Add and place monitors in the Monitors tab.
        </p>
        <label className="flex items-center justify-between rounded-[9px] border border-nb-line px-3 py-2">
          <span className="text-sm text-nb-ink">Active</span>
          <Toggle checked={form.is_active} onChange={(v) => set("is_active", v)} label="Wall active" />
        </label>
      </div>
    </Modal>
  );
}
