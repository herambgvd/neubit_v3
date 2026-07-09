"use client";

import { forwardRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef(function DialogContent(
  { className, children, showClose = true, ...props },
  ref
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/70 backdrop-blur-sm" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-dialog-in rounded-2xl border border-card-border bg-card p-6 shadow-2xl shadow-black/50 outline-none",
          className
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ className, title, description, ...props }) {
  return (
    <div className={cn("mb-5 pr-8", className)} {...props}>
      {title && (
        <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </DialogPrimitive.Title>
      )}
      {description && (
        <DialogPrimitive.Description className="mt-1 text-xs text-muted">
          {description}
        </DialogPrimitive.Description>
      )}
    </div>
  );
}

export function DialogFooter({ className, ...props }) {
  return (
    <div className={cn("mt-6 flex items-center justify-end gap-3", className)} {...props} />
  );
}
