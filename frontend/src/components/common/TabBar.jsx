"use client";

// Reusable horizontal tab bar (underline style). Used by WorkflowConfig,
// the webhook detail modal, Account, etc. — previously hand-rolled each time.
//
//   <TabBar tabs={[{key,label,icon}]} active={tab} onChange={setTab} />
import { Icon } from "@iconify/react";

export function TabBar({ tabs = [], active, onChange, className = "" }) {
  return (
    <nav className={`flex items-stretch gap-0.5 overflow-x-auto border-b border-card-border ${className}`}>
      {tabs.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange?.(t.key)}
            className={`-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted hover:text-foreground"
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
