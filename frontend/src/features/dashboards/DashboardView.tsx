"use client";

// One dashboard, in one of TWO modes.
//
// View and edit are genuinely different, not the same screen with disabled
// buttons:
//
//   VIEW  no drag, no resize, no per-widget chrome beyond the title, no palette.
//         A widget cannot be moved by accident, and the canvas is the whole page.
//   EDIT  the widget palette appears, tiles gain a drag handle and edit/remove
//         actions, and geometry changes become dirty state with an explicit Save.
//
// Mode lives in the URL (`?edit=1`), so a link to a dashboard is a link to VIEW
// it — which is what people share — and reloading in edit mode stays in edit mode.
// Entering edit requires `dashboards.manage`; without it the toggle is not
// rendered and `?edit=1` is ignored, because the backend would refuse the writes
// anyway and a UI that lets you rearrange a canvas it cannot save is a lie.
//
// **Layout is saved EXPLICITLY, not on every drag.** react-grid-layout fires
// `onLayoutChange` continuously while a widget is being dragged; persisting each
// one would be dozens of writes per gesture and a race between them. So changes
// accumulate into `pendingLayout` and go up as ONE `PUT /layout` — which is also
// why the backend has a bulk layout route at all: a drag reflows several widgets
// and either the whole arrangement is saved or none of it is.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConsolePage, LoadingBlock, Segmented } from "@/components/console";
import { Button, ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { dashboards } from "./api";
import type { DashboardDetail, DashboardWidget } from "./api";
import GridCanvas, { WIDGET_DND_TYPE } from "./GridCanvas";
import type { GridItem } from "./GridCanvas";
import { PERM_MANAGE } from "./constants";
import { newSpec } from "./spec";
import type { Viz } from "./spec";
import WidgetEditor from "./WidgetEditor";
import type { EditorValue } from "./WidgetEditor";
import { WIDGET_TYPES } from "./widget-types";

export default function DashboardView({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can(PERM_MANAGE);

  // `?edit=1` only counts if the caller may actually write.
  const editing = canManage && params.get("edit") === "1";

  const [pendingLayout, setPendingLayout] = useState<GridItem[] | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null>(null);
  const [confirm, setConfirm] = useState<any>(null);

  const dashQ = useQuery<DashboardDetail>({
    queryKey: ["dashboard", id],
    queryFn: () => dashboards.get(id),
  });
  const dash = dashQ.data;

  // Leaving edit mode drops unsaved geometry rather than silently keeping it
  // around to be written by some later save.
  useEffect(() => {
    if (!editing) setPendingLayout(null);
  }, [editing]);

  // What the canvas draws: the saved widgets, with any un-saved geometry applied
  // on top. One source of truth for the grid, so the tiles never jump back to
  // their stored positions mid-edit.
  const widgets: DashboardWidget[] = useMemo(() => {
    const base = dash?.widgets || [];
    if (!pendingLayout) return base;
    const byId = new Map(pendingLayout.map((l) => [l.i, l]));
    return base.map((w) => {
      const l = byId.get(w.id);
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
    });
  }, [dash, pendingLayout]);

  const dirty = pendingLayout !== null;

  const setMode = (mode: string) => {
    if (dirty && mode === "view") {
      setConfirm({
        title: "Discard layout changes?",
        message: "The widgets have been moved but not saved. Leaving edit mode discards that.",
        confirmLabel: "Discard",
        danger: true,
        onConfirm: () => {
          setPendingLayout(null);
          setConfirm(null);
          router.replace(`/dashboards/${id}`);
        },
      });
      return;
    }
    router.replace(mode === "edit" ? `/dashboards/${id}?edit=1` : `/dashboards/${id}`);
  };

  // ── mutations ─────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dashboard", id] });
    qc.invalidateQueries({ queryKey: ["dashboards"] });
  };

  const saveLayoutM = useMutation({
    mutationFn: () =>
      dashboards.saveLayout(
        id,
        (pendingLayout || []).map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
      ),
    onSuccess: () => {
      setPendingLayout(null);
      invalidate();
      toast.success("Layout saved");
    },
    onError: (e) => toast.error(apiError(e, "Could not save the layout")),
  });

  const addWidgetM = useMutation({
    mutationFn: (v: EditorValue & { size: { w: number; h: number } }) =>
      dashboards.addWidget(id, {
        title: v.title,
        spec: v.spec,
        // `y` past the bottom is how a new widget lands UNDER the existing ones
        // instead of on top of one; the grid compacts it up to the first free row.
        x: 0,
        y: Math.max(0, ...(dash?.widgets || []).map((w) => w.y + w.h), 0),
        w: v.size.w,
        h: v.size.h,
      }),
    onSuccess: () => {
      setEditorOpen(false);
      invalidate();
      toast.success("Widget added");
    },
    onError: (e) => toast.error(apiError(e, "Could not add the widget")),
  });

  const updateWidgetM = useMutation({
    mutationFn: (v: EditorValue & { size: { w: number; h: number } }) =>
      dashboards.updateWidget(id, editingWidget!.id, { title: v.title, spec: v.spec }),
    onSuccess: () => {
      setEditorOpen(false);
      setEditingWidget(null);
      invalidate();
      toast.success("Widget saved");
    },
    onError: (e) => toast.error(apiError(e, "Could not save the widget")),
  });

  const removeWidgetM = useMutation({
    mutationFn: (widgetId: string) => dashboards.removeWidget(id, widgetId),
    onSuccess: () => {
      setConfirm(null);
      // A removed widget invalidates any un-saved geometry that still names it.
      setPendingLayout(null);
      invalidate();
      toast.success("Widget removed");
    },
    onError: (e) => toast.error(apiError(e, "Could not remove the widget")),
  });

  // `seed` is the editor's starting value for an ADD (as opposed to `editingWidget`
  // for an edit). Kept separate so cancelling an add never mutates a saved widget.
  const [seed, setSeed] = useState<EditorValue | null>(null);

  const addOfType = useCallback((type: string) => {
    setEditingWidget(null);
    // The editor seeds itself from `initial`; passing a fresh spec of this type
    // is how the palette's choice reaches it.
    setSeed({ title: "", spec: newSpec(type as Viz) });
    setEditorOpen(true);
  }, []);

  // The editor resets its form from `initial` whenever that value CHANGES, so it
  // must be referentially stable — a fresh object literal on every render would
  // wipe the form on every keystroke.
  const editorInitial = useMemo<EditorValue | null>(
    () => (editingWidget ? { title: editingWidget.title, spec: editingWidget.spec } : seed),
    [editingWidget, seed],
  );

  // ── render ────────────────────────────────────────────────────────────────

  if (dashQ.isLoading) {
    return (
      <ConsolePage>
        <LoadingBlock label="Loading dashboard…" />
      </ConsolePage>
    );
  }

  if (dashQ.isError || !dash) {
    return (
      <ConsolePage>
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <Icon icon="heroicons:exclamation-triangle" className="text-2xl text-nb-crit" />
          <p className="text-[12.5px] text-nb-crit">
            {apiError(dashQ.error, "That dashboard could not be opened")}
          </p>
          <Button variant="ghost" icon="heroicons:arrow-left" onClick={() => router.push("/dashboards")}>
            Back to dashboards
          </Button>
        </div>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <div className="mb-2.5 flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => router.push("/dashboards")}
          className="rounded-[7px] p-1 text-nb-faint transition hover:bg-[rgba(150,180,245,.1)] hover:text-nb-ink"
          aria-label="Back to dashboards"
          title="Back to dashboards"
        >
          <Icon icon="heroicons:arrow-left" className="text-[15px]" />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold text-nb-ink">{dash.name}</h1>
          {dash.description ? (
            <p className="truncate text-[11px] text-nb-soft">{dash.description}</p>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-nb-warn">Layout not saved</span>
          ) : null}
          {editing ? (
            <>
              <Button
                variant="ghost"
                icon="heroicons:arrow-uturn-left"
                onClick={() => setPendingLayout(null)}
                disabled={!dirty}
              >
                Revert
              </Button>
              <Button
                icon={saveLayoutM.isPending ? "svg-spinners:180-ring" : "heroicons:check"}
                onClick={() => saveLayoutM.mutate()}
                disabled={!dirty || saveLayoutM.isPending}
              >
                Save layout
              </Button>
            </>
          ) : null}
          {canManage ? (
            <Segmented
              value={editing ? "edit" : "view"}
              onChange={setMode}
              options={[
                { value: "view", label: "View", icon: "heroicons:eye" },
                { value: "edit", label: "Edit", icon: "heroicons:pencil-square" },
              ]}
            />
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {editing ? (
          // The widget palette. Click OR drag — the drag path is the ported
          // `onDropType` handler on the canvas.
          <div className="hidden w-[188px] shrink-0 flex-col gap-1.5 overflow-y-auto rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-2.5 lg:flex">
            <span className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
              Add a widget
            </span>
            {WIDGET_TYPES.map((w) => (
              <button
                key={w.type}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(WIDGET_DND_TYPE, w.type);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addOfType(w.type)}
                className="flex cursor-grab flex-col gap-0.5 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2.5 py-2 text-left transition hover:border-nb-line2 active:cursor-grabbing"
              >
                <span className="flex items-center gap-1.5 text-[11.5px] text-nb-ink">
                  <Icon icon={w.icon} className="text-[14px] text-nb-violetb" />
                  {w.label}
                </span>
                <span className="text-[10px] leading-snug text-nb-faint">{w.hint}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* `min-w-0` is load-bearing, not tidying. A flex child defaults to
            `min-width: auto`, so it can be widened by its own content — and the
            grid's content is absolutely positioned at whatever width the grid last
            measured. Without this the first measurement (taken before the palette
            claimed its 188px) makes the canvas too wide, the too-wide content then
            keeps the flex item too wide, and the right-hand column of widgets sits
            outside the viewport permanently. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-[12px]">
          <GridCanvas
            widgets={widgets}
            cols={dash.grid_cols}
            rowHeight={dash.row_height}
            editable={editing}
            onLayoutChange={setPendingLayout}
            onEdit={(w) => {
              setSeed(null);
              setEditingWidget(w);
              setEditorOpen(true);
            }}
            onRemove={(w) =>
              setConfirm({
                title: "Remove widget",
                message: `“${w.title || "Untitled widget"}” will be removed from this dashboard.`,
                confirmLabel: "Remove",
                danger: true,
                onConfirm: () => removeWidgetM.mutate(w.id),
              })
            }
            onDropType={addOfType}
          />
        </div>
      </div>

      <WidgetEditor
        open={editorOpen}
        initial={editorInitial}
        saving={addWidgetM.isPending || updateWidgetM.isPending}
        onClose={() => {
          setEditorOpen(false);
          setEditingWidget(null);
          setSeed(null);
        }}
        onSave={(v) => (editingWidget ? updateWidgetM.mutate(v) : addWidgetM.mutate(v))}
      />

      <ConfirmDialog
        state={confirm}
        onClose={() => setConfirm(null)}
        pending={removeWidgetM.isPending}
      />
    </ConsolePage>
  );
}
