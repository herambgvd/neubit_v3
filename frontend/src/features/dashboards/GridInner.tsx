"use client";

// The react-grid-layout instance itself, isolated behind a client-only dynamic
// import (see `GridCanvas.tsx`).
//
// **Why this file exists at all** — and it is the one place the port could not
// follow the source. The standalone product uses react-grid-layout 1.5 and wraps
// it in `rgl.WidthProvider(rgl.Responsive)`, the higher-order component that
// measures the container and feeds a `width` prop down. This console runs React
// 19, and RGL 1.x reaches it through `react-draggable`'s `findDOMNode`, which
// React 19 REMOVED — so v1 is not an option here. RGL 2.x is, and in 2.x
// `WidthProvider` is gone: it was replaced by the `useContainerWidth` hook, with
// `width` becoming a plain required prop.
//
// A HOC can live inside a `dynamic()` loader; a hook cannot. So the composition
// moves into a real component, which is this file, and `GridCanvas` dynamic-imports
// it with `ssr: false` — preserving the property that actually mattered about the
// original arrangement: react-grid-layout never evaluates on the server.
//
// `measureBeforeMount` is deliberately ON. Without it the grid renders once at
// the hook's 1280px default and then re-lays-out when the real width arrives,
// which on a canvas full of charts is a visible jump and a wasted round of ECharts
// layout work.

import { Responsive, useContainerWidth } from "react-grid-layout";

import type { GridItem } from "./GridCanvas";

export interface GridInnerProps {
  layout: GridItem[];
  cols: { [breakpoint: string]: number };
  rowHeight: number;
  margin: [number, number];
  editable: boolean;
  onLayoutChange: (current: GridItem[]) => void;
  children: React.ReactNode;
}

export default function GridInner({
  layout,
  cols,
  rowHeight,
  margin,
  editable,
  onLayoutChange,
  children,
}: GridInnerProps) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });

  const handleGesture = (current: any) => {
    if (!editable) return;
    onLayoutChange(
      (current || []).map((l: any) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
    );
  };

  return (
    <div ref={containerRef} className="w-full">
      {mounted ? (
        <Responsive
          className="layout"
          width={width}
          layouts={{ lg: layout as any }}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
          cols={cols}
          rowHeight={rowHeight}
          margin={margin}
          // RGL 2.x groups the drag/resize flags into config objects; 1.x (what
          // the source uses) had them as flat `isDraggable` / `isResizable` /
          // `draggableHandle` / `draggableCancel` props. Same three settings,
          // spelled the way this version spells them.
          dragConfig={{
            enabled: editable,
            // The HEADER is the handle, so a drag inside a chart does not pick
            // the widget up. The source makes the whole tile draggable, which
            // fights a chart's own pointer interactions.
            handle: ".widget-drag-handle",
            // Paired with the `onMouseDown` stopPropagation in `ChartWidget` —
            // the two together are why the edit and remove buttons are clickable
            // on a draggable tile. Carried straight over from the source.
            cancel: ".widget-actions",
          }}
          resizeConfig={{ enabled: editable }}
          // GESTURE events, deliberately NOT `onLayoutChange`.
          //
          // The source listens to `onLayoutChange`, which RGL fires for ANY
          // reason — including once on mount and again on every responsive
          // breakpoint change. In a viewer that only reads the layout back that
          // is harmless. Here it was actively wrong twice over: the mount-time
          // call marked a freshly-opened dashboard "not saved" before anything was
          // touched, and a call fired while the container was still measuring at a
          // narrow width delivered the SINGLE-COLUMN layout for that breakpoint —
          // which then became the pending layout and collapsed the canvas.
          //
          // Drag-stop and resize-stop fire only when a person actually moved
          // something, which is exactly the signal "the layout is now dirty" is
          // supposed to mean. A responsive reflow stays a display concern and is
          // never written back over the desktop arrangement.
          onDragStop={(current: any) => handleGesture(current)}
          onResizeStop={(current: any) => handleGesture(current)}
        >
          {children}
        </Responsive>
      ) : null}
    </div>
  );
}
