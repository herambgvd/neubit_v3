"use client";

// Mounts the off-page alarm notifier once, app-wide.
//
// A component rather than a hook call in the shell because the shell is a server
// boundary's child and this needs the client router; and because the hook must
// have exactly ONE subscriber — two would double every toast.
//
// It renders nothing: the corner belongs to `sonner`, which the app already uses
// for every other transient message, so an alarm looks like the console talking
// rather than like a second notification system bolted on.
import { useEventNotifier } from "../hooks/useEventNotifier";

export default function EventNotifierHost() {
  useEventNotifier();
  return null;
}
