"use client";

// ONE realtime connection per tab for the VMS event bridge (SCRUM-325).
//
// The events page, the alarm corner (useEventNotifier) and the popup host each
// opened their own EventSource to /realtime/vms-events. Over plain HTTP a browser
// keeps six connections per host for the whole profile, so three never-ending
// streams per console tab left three for everything else — two tabs, or one tab
// with live and playback sessions waiting on an unreachable recorder, and every
// further API call queued behind them: the events page sat on "Loading events…"
// for good. Every console that streams (Milestone's event server, Genetec's
// Security Desk) keeps one connection per client and fans its messages out; so
// does this hub. Subscribers name the frame type they want and get the parsed
// frames; the connection opens with the first subscriber and closes with the last.
//
// The connection reads the access token at CONNECT time (a reconnect after a
// refresh uses the new one) and, with no token yet, retries on the same capped
// backoff as a dropped stream — the auth provider may still be probing the
// refresh cookie when the first subscriber mounts.
import { api, tokens } from "@/lib/api";

export interface VmsRealtimeSubscriber {
  /** The SSE event name, e.g. "vms.event" or "vms.popup". */
  event: string;
  onFrame: (frame: unknown) => void;
  /** Told the current state at once, then on every change. */
  onConnected?: (connected: boolean) => void;
}

const subscribers = new Set<VmsRealtimeSubscriber>();
const attached = new Set<string>();
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retry = 0;
let connected = false;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const s of subscribers) s.onConnected?.(next);
}

function deliver(event: string, raw: string) {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return; // keepalive/comment — ignore
  }
  if (frame == null) return;
  for (const s of subscribers) if (s.event === event) s.onFrame(frame);
}

function attach(event: string) {
  if (!source || attached.has(event)) return;
  attached.add(event);
  source.addEventListener(event, (e) => deliver(event, (e as MessageEvent<string>).data));
}

function scheduleReconnect() {
  retry = Math.min(retry + 1, 6);
  timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30000));
}

function connect() {
  timer = null;
  if (subscribers.size === 0 || source) return;
  const token = tokens.access;
  if (!token) {
    scheduleReconnect();
    return;
  }
  const es = new EventSource(`${api.defaults.baseURL}/realtime/vms-events?token=${encodeURIComponent(token)}`);
  source = es;
  attached.clear();
  for (const s of subscribers) attach(s.event);
  es.onopen = () => {
    retry = 0;
    setConnected(true);
  };
  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    setConnected(false);
    if (subscribers.size > 0 && !timer) scheduleReconnect();
  };
}

function shutdown() {
  if (timer) clearTimeout(timer);
  timer = null;
  source?.close();
  source = null;
  attached.clear();
  retry = 0;
  setConnected(false);
}

/** Subscribe to one frame type on the tab's shared connection; returns the unsubscribe. */
export function subscribeVmsRealtime(subscriber: VmsRealtimeSubscriber): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};
  subscribers.add(subscriber);
  subscriber.onConnected?.(connected);
  if (source) attach(subscriber.event);
  else if (!timer) connect();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) shutdown();
  };
}
