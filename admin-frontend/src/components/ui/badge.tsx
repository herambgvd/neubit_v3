import type { ComponentPropsWithoutRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Tone-mapped pill. `dot` adds a leading status dot.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-card-border bg-hover text-muted",
        foreground: "border-card-border bg-card text-foreground",
        success: "border-success/20 bg-success/10 text-success",
        warning: "border-warning/20 bg-warning/10 text-warning",
        danger: "border-danger/20 bg-danger/10 text-danger",
        accent: "border-accent/20 bg-accent/10 text-accent",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
);

/** The tone names, derived from the cva variant map so the two cannot drift. */
export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

const dotTone: Record<BadgeTone, string> = {
  neutral: "bg-muted",
  foreground: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
};

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({ tone = "neutral", dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", dotTone[tone])} />}
      {children}
    </span>
  );
}
