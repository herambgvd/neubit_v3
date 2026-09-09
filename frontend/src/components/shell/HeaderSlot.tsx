"use client";

// A page's own controls, rendered INSIDE the global top bar.
//
// The Events console carries a live-state dot and the severity counts an operator
// triages by. They were a row on the page, which cost a row of the viewport on a
// screen where every row below the fold is a row the operator has to scroll to.
// The top bar already names the section ("Events", beside the brand); these belong
// there with it, the way the Live badge does.
//
// The outlet is a plain DOM node published through a module-level store, so a page
// deep in the tree can portal into the header without the header knowing anything
// about the page. When NO outlet is mounted (a unit test rendering the page on its
// own, or a route whose shell has no header), the slot renders its children INLINE
// rather than dropping them — controls that quietly disappear are worse than
// controls in the wrong place.
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

let outlet: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setOutlet(node: HTMLElement | null) {
  outlet = node;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Where the header renders whatever the current page put in the slot. */
export function HeaderSlotOutlet({ className }: { className?: string }) {
  return <div ref={setOutlet} className={className} />;
}

/** Put these controls in the top bar. */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const node = useSyncExternalStore(
    subscribe,
    () => outlet,
    () => null, // the server has no DOM: render inline, hydrate into the portal
  );
  if (!node) return <>{children}</>;
  return createPortal(children, node);
}
