"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactElement, type ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 animate-fade-in rounded-md border border-card-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-lg shadow-black/20",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

export interface TooltipProps {
  content?: ReactNode;
  /** A single element — it becomes the trigger via Radix's `asChild`. */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}

// Convenience wrapper for simple text tooltips.
export function Tooltip({ content, children, side = "top", delayDuration = 200 }: TooltipProps) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipPrimitive.Root>
  );
}
