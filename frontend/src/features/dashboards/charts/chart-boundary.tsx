"use client";

// ChartBoundary — one chart's crash stays one chart's crash.
//
// WHY THIS EXISTS. A user hit an uncaught `Cannot read properties of undefined
// (reading '__ec_inner_26')` — an ECharts internal (`makeInner` keys its
// per-instance state as `__ec_inner_<n>`; reading one off `undefined` means a
// disposed or swapped-out model was touched by a still-pending callback:
// a tooltip/axisPointer handler, an animation frame over a series that
// `notMerge` just removed, a resize landing after dispose). Three headless
// reproduction storms — window-switch churn, hover-during-swap, edit-mode
// drag/resize — could not trigger it, so the exact interleaving is not pinned.
//
// What is certain and unacceptable is the BLAST RADIUS: an internal race in
// one chart's teardown took down the entire console with the framework error
// overlay. A dashboard is many independent widgets; one widget's renderer
// failing is that widget's news, exactly like its "could not run" data state.
// So: a per-widget error boundary. The crashed widget says what happened and
// offers a reload; every other widget keeps rendering.
//
// The full stack is logged (console.error, with the component stack) so the
// NEXT occurrence carries the origin instead of an overlay screenshot — this
// boundary is instrumentation as much as containment. It deliberately does NOT
// auto-retry: the crash is a symptom of a lifecycle race, and silently
// remounting in a loop would hide a real defect behind flicker.
import { Component, type ReactNode } from "react";
import { Icon } from "@iconify/react";

export class ChartBoundary extends Component<
  { children: ReactNode; label?: string },
  { crashed: Error | null }
> {
  state = { crashed: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { crashed: error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // The whole point: next time this fires, the console carries the exact
    // origin — which widget, which renderer, which internal frame.
    console.error(
      `[chart-boundary] renderer crashed${this.props.label ? ` in "${this.props.label}"` : ""}:`,
      error,
      info?.componentStack ?? "(no component stack)"
    );
  }

  render() {
    if (this.state.crashed) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Icon icon="heroicons:exclamation-triangle" className="h-5 w-5 text-nb-warn" />
          <div className="text-[11.5px] text-nb-faint">
            This chart's renderer crashed — the data and every other widget are
            unaffected. The error is in the browser console.
          </div>
          <button
            onClick={() => this.setState({ crashed: null })}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded-[7px] border border-nb-line px-2.5 py-1 text-[11px] font-semibold text-nb-accent hover:bg-[rgba(255,255,255,.04)]"
          >
            Reload chart
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
