"use client";

// The alarm toast, plus the one thing it cannot know about itself: whether it is
// the front of a stack, and how many alarms are behind it.
//
// `EventToast` stays a pure render of one alarm — it takes props and has no idea
// a registry exists, which is what keeps it straightforward to test. This wrapper
// subscribes to the live registry and decides which toast carries the stack-level
// control: the newest one, which sonner puts nearest the corner and which is
// therefore the one an operator is already looking at. Every other toast in the
// stack gets no clear-all, so the button appears exactly once.
import { toast } from "sonner";

import EventToast, { type EventToastProps } from "./EventToast";
import { liveToastIds, unregisterToast, useLiveToasts } from "../liveToasts";

export type LiveEventToastProps = Omit<EventToastProps, "onClearAll" | "clearAllCount"> & {
  /** This toast's sonner id — how it knows whether it is the front one. */
  toastId: string;
};

/** Dismiss every alarm toast, the ones queued behind `visibleToasts` included.
 *  By id rather than `toast.dismiss()`: a bare dismiss would also take out an
 *  unrelated "Saved" or "Could not acknowledge" message the operator has not read. */
export function clearAllEventToasts(): void {
  for (const id of liveToastIds()) {
    toast.dismiss(id);
    // Sonner's onDismiss fires on the exit animation, so the registry is cleared
    // here too — otherwise the count still reads 3 for the length of the fade.
    unregisterToast(id);
  }
}

export default function LiveEventToast({ toastId, ...rest }: LiveEventToastProps) {
  const live = useLiveToasts();
  const isFront = live[0] === toastId;

  return (
    <EventToast
      {...rest}
      onClearAll={isFront ? clearAllEventToasts : undefined}
      clearAllCount={live.length}
    />
  );
}
