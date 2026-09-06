"use client";

import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

const base =
  "w-full rounded-lg border bg-card text-sm text-foreground placeholder:text-muted outline-none transition hover:border-muted focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-50";

export interface InputProps extends ComponentPropsWithoutRef<"input"> {
  /** Paints the error state and sets aria-invalid. */
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        base,
        "h-10 px-3.5",
        invalid && "border-danger/60 focus:border-danger/60 focus:ring-danger/20",
        !invalid && "border-card-border",
        className
      )}
      {...props}
    />
  );
});
