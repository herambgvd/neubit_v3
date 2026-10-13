"use client";

// The small toggle under an evidence pane's picture (Recording ⇄ Live, Snapshot,
// Frame at the read): one word per question the picture answers.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

export default function ModeButton({
  active,
  onClick,
  icon,
  children,
}: Readonly<{
  active: boolean;
  onClick: () => void;
  icon: string;
  children: ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition ${
        active
          ? "bg-blue-500/15 text-blue-300"
          : "text-muted hover:bg-hover hover:text-foreground"
      }`}
    >
      <Icon icon={icon} className="text-xs" />
      {children}
    </button>
  );
}
