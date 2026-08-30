"use client";

// The widget editor — the no-code half of the builder.
//
// It is a form over the query spec, and every control on it corresponds to one
// field of `spec.query`. That correspondence is the point: there is nothing to
// learn beyond "what do you want to look at, which number, over what window",
// and there is no text box in which a user can type something the store cannot
// answer.
//
// Three things it does that matter more than the layout:
//
// 1. **The preview is the real widget.** The right-hand pane renders
//    `<WidgetBody>` — the same component, the same fetch, the same error handling
//    as the canvas. A separate preview renderer would drift, and it would drift
//    first on exactly the states (empty window, refused metric) that a builder
//    most needs to see before saving.
//
// 2. **It steers instead of trapping.** Changing the chart type rewrites
//    `query.kind` from `VIZ_KIND`, because a bar chart asking for time buckets is
//    a spec that can only 400. Choosing a grouping a metric cannot support
//    disables the option and says why, rather than letting the user discover the
//    rule from a server error.
//
// 3. **The scope pickers read the live store.** Devices, points and categories
//    all come from the existing `/bi` API — the same one the two hand-built BI
//    consoles use. Nothing is hard-coded, so a device the gateway starts
//    publishing tomorrow is selectable tomorrow.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Input, Modal, Select } from "@/components/ui/kit";
import { Segmented } from "@/components/console";
import { bi } from "@/features/bi/api";

import { categoryLabel, DEFAULT_SIZE } from "./constants";
import {
  METRIC_META,
  ROLLUP_META,
  VIZ_KIND,
  WINDOWS,
  canGroup,
  newSpec,
  specIssue,
} from "./spec";
import type { GroupBy, Metric, Rollup, ScopeType, Viz, WidgetSpec } from "./spec";
import { WIDGET_TYPES, widgetTypeDef } from "./widget-types";
import { WidgetBody } from "./ChartWidget";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
        {children}
      </span>
      {hint ? <span className="truncate text-[10px] text-nb-faint/70">{hint}</span> : null}
    </div>
  );
}

export interface EditorValue {
  title: string;
  spec: WidgetSpec;
}

export default function WidgetEditor({
  open,
  initial,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  initial?: EditorValue | null;
  onClose: () => void;
  onSave: (value: EditorValue & { size: { w: number; h: number } }) => void;
  saving?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState<WidgetSpec>(() => newSpec("line"));

  // Reset from `initial` whenever the dialog OPENS, not on every render: editing
  // a widget must start from what is saved, and typing must not be clobbered.
  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setSpec(initial?.spec ? structuredClone(initial.spec) : newSpec("line"));
  }, [open, initial]);

  const patchQuery = (patch: Record<string, any>) =>
    setSpec((s) => ({ ...s, query: { ...s.query, ...patch } }));
  const patchScope = (patch: Record<string, any>) =>
    setSpec((s) => ({ ...s, query: { ...s.query, scope: { ...s.query.scope, ...patch } } }));

  const scopeType = spec.query.scope.type;

  // ── the live store, for the pickers ───────────────────────────────────────

  const devicesQ = useQuery<any>({
    queryKey: ["bi-devices-all"],
    queryFn: () => bi.devices({ limit: 500 }),
    enabled: open,
    staleTime: 60_000,
  });
  const devices = devicesQ.data?.items || [];

  // The category vocabulary is the GATEWAY's — derived from what actually
  // reported, never a hard-coded list.
  const categories = useMemo(() => {
    const set = new Map<string, number>();
    for (const d of devices) set.set(d.category ?? "", (set.get(d.category ?? "") || 0) + 1);
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [devices]);

  // Points for the explicit picker. Scoped to the chosen device when there is
  // one, so the list is a few dozen rather than three hundred.
  const [pointDevice, setPointDevice] = useState<string>("");

  // Opening the editor on an EXISTING widget should show the points it uses, not
  // an alphabetical list of 314 in which they are invisible. Jump the filter to
  // the device the first selected point belongs to.
  const firstSelected = (initial?.spec?.query?.scope?.point_ids || [])[0];
  const focusQ = useQuery<any>({
    queryKey: ["bi-point-device", firstSelected],
    queryFn: () => bi.points({ with_latest: false, limit: 500 }),
    enabled: open && !!firstSelected,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!open || !firstSelected) return;
    const hit = (focusQ.data?.items || []).find((p: any) => p.point_id === firstSelected);
    if (hit?.device_id) setPointDevice(hit.device_id);
  }, [open, firstSelected, focusQ.data]);
  const pointsQ = useQuery<any>({
    queryKey: ["bi-points-picker", pointDevice],
    queryFn: () =>
      bi.points({
        device_id: pointDevice || undefined,
        with_latest: false,
        limit: 500,
      }),
    enabled: open && scopeType === "points",
    staleTime: 60_000,
  });
  const points = pointsQ.data?.items || [];

  const selected = new Set(spec.query.scope.point_ids || []);
  const togglePoint = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patchScope({ point_ids: [...next] });
  };

  // ── steering ──────────────────────────────────────────────────────────────

  const setViz = (viz: Viz) =>
    setSpec((s) => ({
      ...s,
      viz,
      query: {
        ...s.query,
        // A chart type implies a result shape. Flip it here so a bar chart never
        // ends up asking for time buckets it cannot draw.
        kind: VIZ_KIND[viz],
        // A stat is one number by definition.
        limit: viz === "stat" ? 1 : s.query.limit === 1 ? 8 : s.query.limit,
        group_by: VIZ_KIND[viz] === "series" ? "point" : s.query.group_by,
      },
    }));

  const issue = specIssue(spec);
  const isAggregate = spec.query.kind === "aggregate";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={initial ? "Edit widget" : "Add widget"}
      subtitle="Pick what to look at and which number. No query language — the store answers by scope, metric, window and rollup."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({
                title,
                spec,
                size: DEFAULT_SIZE[spec.viz] || { w: 4, h: 4 },
              })
            }
            disabled={!!issue || !!saving}
            icon={saving ? "svg-spinners:180-ring" : "heroicons:check"}
          >
            {initial ? "Save widget" : "Add widget"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── the form ─────────────────────────────────────────────────── */}
        <div className="space-y-3.5">
          <Input
            label="Title"
            value={title}
            onChange={(e: any) => setTitle(e.target.value)}
            placeholder="e.g. Main incomer current"
          />

          <div>
            <FieldLabel hint={widgetTypeDef(spec.viz)?.hint}>Chart</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {WIDGET_TYPES.map((w) => (
                <button
                  key={w.type}
                  type="button"
                  title={w.hint}
                  onClick={() => setViz(w.type as Viz)}
                  className={`flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] transition ${
                    spec.viz === w.type
                      ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
                      : "border-nb-line text-nb-faint hover:text-nb-muted"
                  }`}
                >
                  <Icon icon={w.icon} className="text-[14px]" />
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Scope</FieldLabel>
            <Segmented
              value={scopeType}
              onChange={(t: ScopeType) =>
                patchScope({
                  type: t,
                  // Clear the other branches' selections so a saved spec never
                  // carries a device_id that its scope type ignores.
                  point_ids: t === "points" ? spec.query.scope.point_ids || [] : [],
                  device_id: null,
                  device_tag: null,
                  category: t === "category" ? (spec.query.scope.category ?? "") : null,
                })
              }
              options={[
                { value: "points", label: "Points" },
                { value: "device", label: "Device" },
                { value: "category", label: "Category" },
                { value: "all", label: "Everything" },
              ]}
            />
          </div>

          {scopeType === "device" ? (
            <Select
              label="Device"
              placeholder="Select a device…"
              value={spec.query.scope.device_id || ""}
              onChange={(e: any) => patchScope({ device_id: e.target.value || null })}
              options={devices.map((d: any) => ({
                value: d.device_id,
                label: `${d.device_tag} · ${d.points} points`,
              }))}
            />
          ) : null}

          {scopeType === "category" ? (
            <Select
              label="Category"
              placeholder="Select a category…"
              value={spec.query.scope.category ?? ""}
              onChange={(e: any) => patchScope({ category: e.target.value })}
              options={categories.map(([key, n]) => ({
                value: key,
                label: `${categoryLabel(key)} · ${n} devices`,
              }))}
            />
          ) : null}

          {scopeType === "points" ? (
            <div>
              <FieldLabel hint={`${selected.size} selected`}>Points</FieldLabel>
              <Select
                value={pointDevice}
                onChange={(e: any) => setPointDevice(e.target.value)}
                className="mb-1.5"
                options={[
                  { value: "", label: "All devices" },
                  ...devices.map((d: any) => ({ value: d.device_id, label: d.device_tag })),
                ]}
              />
              <div className="max-h-44 overflow-y-auto rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] p-1">
                {pointsQ.isLoading ? (
                  <div className="px-2 py-3 text-[11.5px] text-nb-faint">Loading points…</div>
                ) : !points.length ? (
                  <div className="px-2 py-3 text-[11.5px] text-nb-faint">No points here.</div>
                ) : (
                  points.map((p: any) => (
                    <label
                      key={p.point_id}
                      className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-[11.5px] hover:bg-[rgba(150,180,245,.08)]"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-nb-blue"
                        checked={selected.has(p.point_id)}
                        onChange={() => togglePoint(p.point_id)}
                      />
                      <span className="truncate text-nb-ink">{p.point_tag}</span>
                      <span className="ml-auto shrink-0 truncate text-[10.5px] text-nb-faint">
                        {p.device_tag}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Metric"
              value={spec.query.metric}
              onChange={(e: any) => patchQuery({ metric: e.target.value as Metric })}
              options={(Object.keys(METRIC_META) as Metric[]).map((m) => ({
                value: m,
                label: METRIC_META[m].label,
              }))}
            />
            <Select
              label="Resolution"
              value={spec.query.rollup}
              onChange={(e: any) => patchQuery({ rollup: e.target.value as Rollup })}
              options={(Object.keys(ROLLUP_META) as Rollup[]).map((r) => ({
                value: r,
                label: ROLLUP_META[r].label,
              }))}
            />
          </div>
          <p className="-mt-1.5 text-[10.5px] leading-snug text-nb-faint">
            {METRIC_META[spec.query.metric].blurb} {ROLLUP_META[spec.query.rollup].blurb}
          </p>

          <div>
            <FieldLabel>Window</FieldLabel>
            <Segmented
              value={String(spec.query.window.last_hours ?? 6)}
              onChange={(v: string) =>
                patchQuery({ window: { last_hours: Number(v) } })
              }
              options={WINDOWS.map((w) => ({ value: String(w.hours), label: w.label }))}
            />
          </div>

          {isAggregate ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Group by</FieldLabel>
                <div className="flex gap-1.5">
                  {(["point", "device", "category"] as GroupBy[]).map((g) => {
                    const allowed = canGroup(spec.query.metric, g);
                    return (
                      <button
                        key={g}
                        type="button"
                        disabled={!allowed}
                        title={
                          allowed
                            ? undefined
                            : "Values from different points are not comparable — no unit is on the wire. Use Samples to group."
                        }
                        onClick={() => patchQuery({ group_by: g })}
                        className={`rounded-[7px] border px-2 py-1 text-[11px] capitalize transition ${
                          spec.query.group_by === g
                            ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
                            : allowed
                              ? "border-nb-line text-nb-faint hover:text-nb-muted"
                              : "cursor-not-allowed border-nb-line/50 text-nb-faint/40"
                        }`}
                      >
                        {g}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Input
                label="Rows"
                type="number"
                min={1}
                max={100}
                value={spec.query.limit}
                onChange={(e: any) =>
                  patchQuery({ limit: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
                }
              />
            </div>
          ) : (
            <Input
              label="Lines"
              hint="At most 24 — a chart with more is unreadable and slow."
              type="number"
              min={1}
              max={24}
              value={spec.query.limit}
              onChange={(e: any) =>
                patchQuery({ limit: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })
              }
            />
          )}
        </div>

        {/* ── the live preview ─────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-col">
          <FieldLabel hint="the same renderer the canvas uses">Preview</FieldLabel>
          <div className="h-[300px] overflow-hidden rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.55)]">
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[1.4px] text-nb-muted">
                {title || "Untitled widget"}
              </div>
              <div className="min-h-0 flex-1">
                <WidgetBody spec={spec} />
              </div>
            </div>
          </div>
          {issue ? (
            <p className="mt-2 text-[11px] leading-snug text-nb-warn">{issue}</p>
          ) : (
            <p className="mt-2 text-[10.5px] leading-snug text-nb-faint">
              No unit is shown anywhere. The source payloads carry none, and a
              guessed one on a dashboard is worse than a blank.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
