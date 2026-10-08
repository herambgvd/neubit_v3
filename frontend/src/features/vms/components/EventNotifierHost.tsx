"use client";

// Mounts the off-page alarm notifier once, app-wide.
//
// A component rather than a hook call in the shell because the shell is a server
// boundary's child and this needs the client router; and because the hook must
// have exactly ONE subscriber — two would queue every alarm twice.
//
// The hook fills the alarm queue; AlarmCorner shows it, in the same bottom-right
// corner as the app's other messages, which move up out of its way.
import AlarmCorner from "./AlarmCorner";
import { useEventNotifier } from "../hooks/useEventNotifier";

export default function EventNotifierHost() {
  useEventNotifier();
  return <AlarmCorner />;
}
