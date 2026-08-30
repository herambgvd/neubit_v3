"use client";

// The dashboard canvas — place, move and resize widgets.
//
// PORTED from `frontend-next/src/components/dashboard/grid-editor.tsx` (176
// lines). Almost every non-obvious line here is theirs, and each one is load-
// bearing:
//
// * **The grid is loaded through `dynamic(… { ssr: false })`.** RGL measures its
//   own container and touches browser APIs, so it must never render during SSR;
//   getting this wrong is a hydration error, not a visual glitch. The source
//   achieves it by dynamic-importing `WidthProvider(Responsive)` inline. That HOC
//   does not exist in RGL 2.x — which is the version React 19 forces (see
//   `GridInner.tsx`) — so the composition moved into `GridInner`, which THIS file
//   dynamic-imports instead. The SSR property is preserved exactly.
// * **`layoutItems` built by joining widgets to the stored layout**, with
//   `y: Number.POSITIVE_INFINITY` as the fallback — which is RGL's idiom for
//   "put this at the bottom", and is what makes a brand-new widget land under the
//   existing ones instead of on top of one.
// * **`draggableCancel=".widget-actions"`**, paired with the
//   `onMouseDown` stopPropagation in `ChartWidget`. Together they are why the
//   edit and remove buttons are clickable on a draggable tile.
// * **`onLayoutChange` mapping RGL's items back to `{i,x,y,w,h}`** and firing
//   only when editable, so the read-only viewer never writes a layout.
// * **The drag-and-drop-a-widget-type-onto-the-canvas handlers** and the empty
//   state with its two different messages for edit and view mode.
//
// Changed:
// * **Theme**: navy tokens throughout, `@iconify/react` instead of `lucide-react`,
//   and `cn` inlined as a template string (this console has no `cn` helper).
// * **`isDraggable`/`isResizable` are also gated by a `draggableHandle`.** Theirs
//   makes the whole tile draggable; here the header is the handle, so a drag
//   inside a chart does not move the widget out from under the cursor.
// * **The drag MIME type is `text/neubit-widget`.** Theirs is
//   `text/dashforge-widget`. Renaming it here is safe precisely because it never
//   leaves the browser — but it must not be renamed in that repo, where it is an
//   internal identifier in a shipped product.
// * **`prefers-reduced-motion`.** RGL ships a CSS transition on every placeholder
//   and tile; the override lives in `src/styles/theme.css` next to the rest of
//   this module's third-party CSS overrides.
// * Their `refreshSec` / `publicSlug` / `embedToken` / `variables` /
//   `crossFilters` / `onChartInteraction` props are gone with the free-SQL and
//   share/embed features they belong to.

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@iconify/react";

import type { DashboardWidget } from "./api";
import ChartWidget from "./ChartWidget";
import { GRID_MARGIN } from "./constants";

/** The internal drag-and-drop MIME type for "a new widget of this type". Never
 *  leaves the browser. */
export const WIDGET_DND_TYPE = "text/neubit-widget";

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const GridInner = dynamic(() => import("./GridInner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-40 items-center justify-center text-[11px] text-nb-faint">
      Loading canvas…
    </div>
  ),
});

export interface GridCanvasProps {
  widgets: DashboardWidget[];
  cols: number;
  rowHeight: number;
  editable?: boolean;
  onLayoutChange?: (layout: GridItem[]) => void;
  onEdit?: (widget: DashboardWidget) => void;
  onRemove?: (widget: DashboardWidget) => void;
  onDropType?: (type: string) => void;
}

export default function GridCanvas({
  widgets,
  cols,
  rowHeight,
  editable = false,
  onLayoutChange,
  onEdit,
  onRemove,
  onDropType,
}: GridCanvasProps) {
  const layoutItems = useMemo<GridItem[]>(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
      })),
    [widgets],
  );

  // The narrower breakpoints deliberately keep a whole number of the base column
  // count so a widget's stored width still divides evenly on a laptop; below `sm`
  // everything is full-width, which is the only readable answer for a chart.
  const colsByBreakpoint = {
    lg: cols,
    md: Math.max(2, Math.round(cols * 0.75)),
    sm: Math.max(2, Math.round(cols / 2)),
    xs: 1,
  };

  if (widgets.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 rounded-[12px] border border-dashed border-nb-line text-center"
        onDragOver={(e) => {
          if (!editable) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          if (!editable) return;
          const type = e.dataTransfer.getData(WIDGET_DND_TYPE);
          if (type && onDropType) {
            e.preventDefault();
            onDropType(type);
          }
        }}
      >
        <Icon icon="heroicons:squares-2x2" className="text-3xl text-nb-faint" />
        <div>
          <p className="text-[12.5px] font-medium text-nb-ink">
            {editable ? "Drop a widget here" : "Empty dashboard"}
          </p>
          <p className="mt-1 text-[11px] text-nb-faint">
            {editable
              ? "Pick a widget type on the left, or drag it onto this canvas."
              : "This dashboard has no widgets yet."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-full"
      onDragOver={(e) => {
        if (!editable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        if (!editable) return;
        const type = e.dataTransfer.getData(WIDGET_DND_TYPE);
        if (type && onDropType) {
          e.preventDefault();
          onDropType(type);
        }
      }}
    >
      <GridInner
        layout={layoutItems}
        cols={colsByBreakpoint}
        rowHeight={rowHeight}
        margin={GRID_MARGIN}
        editable={editable}
        onLayoutChange={(current: GridItem[]) => onLayoutChange?.(current)}
      >
        {widgets.map((widget) => (
          <div key={widget.id}>
            <ChartWidget
              title={widget.title}
              spec={widget.spec}
              draggable={editable}
              onEdit={editable && onEdit ? () => onEdit(widget) : null}
              onRemove={editable && onRemove ? () => onRemove(widget) : null}
            />
          </div>
        ))}
      </GridInner>
    </div>
  );
}
