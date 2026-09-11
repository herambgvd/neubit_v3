// WHICH ALARM TOASTS ARE STILL ON SCREEN.
//
// Sonner owns the corner and hands each toast an id, but it will not tell you how
// many of yours are up — and with `visibleToasts` at its default of 3, a burst
// leaves more of them QUEUED behind the ones you can see. So an operator who
// dismisses the three in front gets three more, and the only way out is to keep
// clicking.
//
// This is the registry that makes "clear all" possible and honest: every alarm
// toast registers when it is raised and unregisters when it goes, whether that
// was a click, the auto-close timer, or the clear-all itself. The count includes
// the queued ones, because those are exactly the ones the operator cannot see and
// is trying to get rid of.
//
// Newest first, because sonner puts the newest toast at the front of the stack
// (nearest the corner, for a bottom-right Toaster) — that is the one an operator
// is looking at, and so the one that carries the stack-level control.
import { useSyncExternalStore } from "react";

let ids: string[] = [];
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** The live alarm toasts, newest first. A stable reference between changes, so
 *  `useSyncExternalStore` does not re-render on every unrelated commit. */
export function liveToastIds(): string[] {
  return ids;
}

export function registerToast(id: string): void {
  if (ids[0] === id) return;
  ids = [id, ...ids.filter((x) => x !== id)];
  emit();
}

export function unregisterToast(id: string): void {
  if (!ids.includes(id)) return;
  ids = ids.filter((x) => x !== id);
  emit();
}

/** Test-only reset; a module-level store outlives a test otherwise. */
export function resetToasts(): void {
  if (!ids.length) return;
  ids = [];
  emit();
}

export function useLiveToasts(): string[] {
  return useSyncExternalStore(subscribe, liveToastIds, liveToastIds);
}
