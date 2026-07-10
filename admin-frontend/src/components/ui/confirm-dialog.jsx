"use client";

import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogClose } from "./dialog";
import { Button } from "./button";

/**
 * Controlled confirmation dialog for destructive/irreversible actions.
 *
 * <ConfirmDialog
 *   open={open} onOpenChange={setOpen}
 *   title="Delete tenant?" description="This cannot be undone."
 *   confirmLabel="Delete" variant="danger" loading={mut.isPending}
 *   onConfirm={() => mut.mutate()}
 * />
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  loading = false,
  onConfirm,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader title={title} description={description} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{cancelLabel}</Button>
          </DialogClose>
          <Button variant={variant} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
