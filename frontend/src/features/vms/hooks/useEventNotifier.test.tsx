/**
 * THE SPLIT EVERY ENTERPRISE VMS MAKES, and why it is not cosmetic.
 *
 *   * On the alarm-MONITORING surface, an alarm shows its VIDEO — the operator is
 *     there to watch, so the console switches the canvas.
 *   * ANYWHERE ELSE it is a corner toast: what, where, and one click to go look.
 *     Never a camera thrown over a form somebody is filling in.
 *
 * And a rule that decides whether the mechanism is worth anything at all: it
 * fires for alarms, not for every frame the estate produces. A console that
 * toasts a heartbeat teaches an operator to ignore toasts, and then it has no way
 * left to tell them something is wrong.
 */
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the file's own consts, so the spy is created INSIDE
// the factory and read back through the mocked module.
vi.mock("sonner", () => {
  const fn = vi.fn();
  return {
    toast: Object.assign(fn, {
      success: vi.fn(),
      error: vi.fn(),
      custom: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

const push = vi.fn();
let pathname = "/streaming";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

let frames: unknown[] = [];
vi.mock("./useVmsEventStream", () => ({
  useVmsEventStream: () => ({ events: frames, connected: true }),
}));

// The estate roster: the corner names the camera and the recorder that owns it,
// which is the difference between "Channel 1" and a node-side uuid.
vi.mock("./useEstateCameras", () => ({
  useEstateCameras: () => ({
    cameras: [{ id: "fed:n1:cam-1", real_id: "fed-cam-1", name: "Lobby entrance", node_name: "recorder-a" }],
  }),
}));

const ack = vi.fn((_id: string) => Promise.resolve({}));
vi.mock("../api", () => ({ vms: { events: { ack: (id: string) => ack(id) } } }));

import { toast as toastImport } from "sonner";

import { setEventsMuted, useEventNotifier } from "./useEventNotifier";

const toast = toastImport as unknown as ReturnType<typeof vi.fn> & {
  custom: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
};

/** The hook needs a QueryClient (it invalidates the feed after an ack). */
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
const run = () => renderHook(() => useEventNotifier(), { wrapper });

/** Render whatever the notifier handed sonner, so the toast can be asserted on
 *  as the thing an operator actually sees. */
function renderToast(call = 0) {
  const node = (toast.custom.mock.calls[call][0] as (id: string) => ReactNode)("toast-1");
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

const frame = (over: Record<string, unknown> = {}) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  event_id: over.event_id ?? `x-${Math.random().toString(36).slice(2)}`,
  camera_id: "fed-cam-1",
  camera_name: "Channel 1",
  event_type: "motion",
  severity: "alarm",
  occurred_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  toast.mockClear();
  toast.custom.mockClear();
  toast.dismiss.mockClear();
  ack.mockClear();
  push.mockClear();
  frames = [];
  pathname = "/streaming";
  setEventsMuted(false);
});

describe("off the Events page", () => {
  it("says what, how bad, where and when — not just a type and a name", () => {
    // It used to be one line, "tamper · Channel 2", which is barely more than
    // "something happened". An operator triages on severity, camera, recorder and
    // age, and every one of those was a page away.
    frames = [frame({ event_type: "tamper", severity: "critical" })];
    run();
    renderToast();

    expect(screen.getByText("Tamper")).toBeInTheDocument();
    expect(screen.getByText("Critical")).toBeInTheDocument();
    // The ESTATE's name for the camera, and the recorder that owns it — the frame
    // itself only carried "Channel 1" and a node-side id.
    expect(screen.getByText(/Lobby entrance/)).toBeInTheDocument();
    expect(screen.getByText(/recorder-a/)).toBeInTheDocument();
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  it("takes one click to the event that raised it", async () => {
    frames = [frame({ event_id: "ev-9" })];
    run();
    renderToast();

    await userEvent.click(screen.getByRole("button", { name: /view video/i }));
    expect(push).toHaveBeenCalledWith("/events?event=ev-9");
  });

  it("acknowledges from the corner, without opening the page", async () => {
    // An alarm an operator RECOGNISES should not cost a navigation to close.
    frames = [frame({ id: "row-7" })];
    run();
    renderToast();

    await userEvent.click(screen.getByRole("button", { name: /acknowledge/i }));
    expect(ack).toHaveBeenCalledWith("row-7");
  });

  it("a critical waits for a decision instead of expiring", () => {
    frames = [frame({ severity: "critical" })];
    run();
    const opts = toast.custom.mock.calls[0][1] as { duration: number };
    expect(opts.duration).toBe(Infinity);
  });

  it("stays quiet for anything below an alarm", () => {
    // The rule that keeps the mechanism worth having.
    frames = [frame({ severity: "info" }), frame({ severity: "warning" })];
    run();
    expect(toast.custom).not.toHaveBeenCalled();
  });

  it("stays quiet when the operator muted it", () => {
    setEventsMuted(true);
    frames = [frame()];
    run();
    expect(toast.custom).not.toHaveBeenCalled();
  });

  it("says a thing once, however often the buffer replays it", () => {
    const one = frame({ event_id: "ev-dup" });
    frames = [one, { ...one }];
    run();
    expect(toast.custom).toHaveBeenCalledTimes(1);
  });
});

describe("on the Events page", () => {
  it("says nothing — the video is already showing it", () => {
    pathname = "/events";
    frames = [frame()];
    run();
    expect(toast.custom).not.toHaveBeenCalled();
  });

  it("does not toast it LATER either, once the operator navigates away", () => {
    // The buffer replays on the next surface. An event they already watched must
    // not chase them across the console.
    pathname = "/events";
    const one = frame({ event_id: "ev-seen" });
    frames = [one];
    const { rerender } = renderHook(() => useEventNotifier(), { wrapper });

    pathname = "/streaming";
    rerender();
    expect(toast.custom).not.toHaveBeenCalled();
  });
});
