"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const Textarea = forwardRef(function Textarea(
  { className, invalid = false, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-lg border bg-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted outline-none transition hover:border-muted focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-50",
        invalid ? "border-danger/60 focus:border-danger/60 focus:ring-danger/20" : "border-card-border",
        className
      )}
      {...props}
    />
  );
});
