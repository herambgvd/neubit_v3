"use client";

// Reusable horizontal tab bar (underline style). Used by WorkflowConfig,
// the webhook detail modal, Account, etc. — previously hand-rolled each time.
//
//   <TabBar tabs={[{key,label,icon}]} active={tab} onChange={setTab} />
import { Icon } from "@iconify/react";
import type { ReactNode } from "react";

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  icon?: string;
}

export interface TabBarProps<K extends string = string> {
  tabs?: TabItem<K>[];
  active?: K | null;
  /** NoInfer: `K` is fixed by `tabs`/`active`, not by a setState handler. */
  onChange?: (key: NoInfer<K>) => void;
  className?: string;
}

export function TabBar<K extends string = string>({ tabs = [], active, onChange, className = "" }: TabBarProps<K>) {
  // The tabs deliberately carry NO negative bottom margin. Setting overflow-x makes the
  // browser compute overflow-y from `visible` up to `auto`, so a `-mb-px` here (to lap the
  // active underline over the strip's border) left each tab 1px taller than the content
  // box — turning the strip into a 1px-scrollable container with its own vertical
  // scrollbar, and clipping border-b-2 down to a barely-visible sliver. Without it the
  // strip has zero vertical overflow, so there is nothing to scroll and the underline
  // paints at its full 2px. Horizontal scrolling still works.
  return (
    // `role="tablist"` + `role="tab"` + `aria-selected`: this strip switches
    // between views of one thing, and as bare buttons it announced neither that
    // it was a tab set nor which tab was current.
    <nav
      role="tablist"
      className={`flex items-stretch gap-0.5 overflow-x-auto border-b border-nb-line ${className}`}
    >
      {tabs.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange?.(t.key)}
            className={`inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              isActive
                ? "border-nb-blue text-nb-blueb"
                : "border-transparent text-nb-muted hover:text-nb-ink"
            }`}
          >
            {t.icon && <Icon icon={t.icon} className="text-base" />}
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

export default TabBar;
