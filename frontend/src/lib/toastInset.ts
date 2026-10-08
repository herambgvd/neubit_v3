// ROOM THE TOASTS LEAVE AT THE BOTTOM OF THE CORNER.
//
// Something that lives in the bottom-right corner itself (the VMS alarm card)
// reports its height here, and the app's toaster sits that much higher, so a
// transient "could not acknowledge" lands above the card instead of on it. 0
// while nothing holds the corner.
import { useSyncExternalStore } from "react";

let inset = 0;
const subscribers = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Pixels taken from the bottom of the corner, gap not included. */
export function toastInset(): number {
  return inset;
}

export function setToastInset(px: number): void {
  const next = Math.max(0, Math.round(px));
  if (next === inset) return;
  inset = next;
  for (const fn of subscribers) fn();
}

export function useToastInset(): number {
  return useSyncExternalStore(subscribe, toastInset, () => 0);
}
