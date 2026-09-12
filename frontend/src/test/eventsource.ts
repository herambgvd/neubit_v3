import { vi } from "vitest";

/**
 * A minimal EventSource stand-in. jsdom ships none, and the console's SSE hooks
 * bail out entirely when `EventSource` is undefined — so without this they would
 * silently never connect and every stream test would pass vacuously.
 *
 * Instances are recorded so a test can assert HOW MANY connections were opened,
 * with what URL, and whether they were closed.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
  }

  // Deliberately inert: an instance is thrown away after close(), and tests
  // assert on connections opened, never on listeners left behind.
  removeEventListener() {}

  close() {
    this.closed = true;
  }

  /** Deliver one named SSE frame to whatever registered for it. */
  emit(type: string, data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const h of this.listeners.get(type) || []) {
      h({ data: payload } as MessageEvent<string>);
    }
  }

  open() {
    this.onopen?.();
  }

  fail() {
    this.onerror?.();
  }

  static reset() {
    FakeEventSource.instances = [];
  }

  static get last(): FakeEventSource | undefined {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

/** Install the stub as the global EventSource for the current test. */
export function stubEventSource() {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  return FakeEventSource;
}
