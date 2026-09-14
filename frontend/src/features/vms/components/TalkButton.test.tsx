/**
 * PUSH-TO-TALK: WHAT MUST NOT HAPPEN.
 *
 * Every property here is about a failure the operator cannot see. The button looks
 * identical whether the microphone is reaching the camera's speaker or feeding a
 * pipeline that ends nowhere, so the tests are about the things underneath it:
 *
 *   * A browser that cannot capture must be turned away BEFORE the recorder is
 *     asked — otherwise the estate holds an audit record saying somebody spoke into
 *     a camera, for a talkspurt that never left the machine.
 *   * The microphone is never left hot. Not when the worklet fails to load, not
 *     when the operator lets go during the handshake.
 *   * The capture node is CONNECTED THROUGH TO THE DESTINATION, because a node that
 *     is not pulled never runs — and the gain in between is 0, because a node that
 *     is pulled plays the operator's own voice back into the room.
 *
 * That last pair is the anti-feedback guard, rebuilt for the worklet. The
 * ScriptProcessor version zero-filled an output buffer handed to a main-thread
 * callback; a worklet has no such buffer, so the guard had to be re-established
 * rather than carried across. Its other half — the worklet writing nothing to its
 * output — is held in lib/talkWorklet.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";

import TalkButton from "./TalkButton";

const NODE = "n1";
const CAM = "c1";
const BEGIN = `POST /vms/federation/nodes/${NODE}/cameras/${CAM}/talk`;

const toasts: string[] = [];
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toasts.push(m),
    success: (m: string) => toasts.push(m),
  },
}));

// ── a fake Web Audio graph we can inspect ────────────────────────────────────
class FakePort {
  onmessage: unknown = null;
  posted: unknown[] = [];
  postMessage(data: unknown) {
    this.posted.push(data);
  }
}

class FakeNode {
  port = new FakePort();
  connected: unknown[] = [];
  disconnected = false;
  connect(to: unknown) {
    this.connected.push(to);
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = { value: 1 };
}

let graph: {
  ctx: FakeCtx | null;
  node: FakeNode | null;
  gain: FakeGain | null;
  source: FakeNode | null;
  tracks: { stopped: boolean }[];
};

let addModuleRejects = false;

class FakeCtx {
  destination = { id: "destination" };
  closed = false;
  constructor(public options: { sampleRate: number }) {
    graph.ctx = this;
  }
  createMediaStreamSource() {
    graph.source = new FakeNode();
    return graph.source;
  }
  createGain() {
    graph.gain = new FakeGain();
    return graph.gain;
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

// `audioWorklet` goes on the PROTOTYPE, not on instances. A real browser inherits it
// from BaseAudioContext.prototype, which is what makes the app's `"audioWorklet" in
// AudioContext.prototype` probe work — and a class field here would be an instance
// property, so the probe would report a capable browser as unable to talk and the
// tests below would exercise the refusal path while claiming to cover the live one.
Object.defineProperty(FakeCtx.prototype, "audioWorklet", {
  configurable: true,
  get(): { addModule: (url: string) => Promise<void> } {
    return {
      addModule: () =>
        addModuleRejects ? Promise.reject(new Error("404 Not Found")) : Promise.resolve(),
    };
  },
});

function installAudio({ addModuleFails = false } = {}) {
  (globalThis as Record<string, unknown>).AudioContext = FakeCtx;
  (globalThis as Record<string, unknown>).AudioWorkletNode = class {
    port = new FakePort();
    connected: unknown[] = [];
    disconnected = false;
    constructor() {
      graph.node = this as unknown as FakeNode;
    }
    connect(to: unknown) {
      this.connected.push(to);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  addModuleRejects = addModuleFails;
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  graph.tracks = tracks;
  (globalThis.navigator as unknown as Record<string, unknown>).mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => tracks }),
  };
}

beforeEach(() => {
  toasts.length = 0;
  graph = { ctx: null, node: null, gain: null, source: null, tracks: [] };
  addModuleRejects = false;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).AudioContext;
  delete (globalThis as Record<string, unknown>).AudioWorkletNode;
});

function render(begin?: () => unknown) {
  const stub = stubApi({ [BEGIN]: begin ?? (() => ({ ok: true })) });
  renderWithProviders(<TalkButton nodeId={NODE} cameraId={CAM} />);
  return stub;
}

/** Press and hold. `fireEvent` is used rather than userEvent because jsdom's
 *  pointer events drop the properties the component reads. */
async function press() {
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.pointerDown(screen.getByRole("button"));
}

async function release() {
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.pointerUp(screen.getByRole("button"));
}

describe("a browser that cannot capture", () => {
  it("is refused before the recorder is ever asked", async () => {
    // The audit record is the point. Booking a session and writing "somebody spoke
    // into this camera" for audio that never left the machine is worse than the
    // button not working: it puts a false fact into the estate's history.
    delete (globalThis as Record<string, unknown>).AudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = FakeCtx;
    const stub = render();
    await press();
    await waitFor(() => expect(toasts.length).toBe(1));
    expect(toasts[0]).toMatch(/cannot capture audio/i);
    expect(stub.matching(BEGIN)).toHaveLength(0);
  });
});

describe("a worklet that will not load", () => {
  it("does not leave the microphone open", async () => {
    // A bad deploy or an offline appliance. The recorder has already been asked by
    // this point, so the only thing left to get right is the mic.
    installAudio({ addModuleFails: true });
    render();
    await press();
    await waitFor(() => expect(toasts.length).toBe(1));
    expect(toasts[0]).toMatch(/could not start/i);
    expect(graph.tracks.every((t) => t.stopped)).toBe(true);
    expect(graph.ctx?.closed).toBe(true);
  });
});

describe("a live press", () => {
  beforeEach(() => installAudio());

  it("captures at G.711's rate so the browser does the resampling", async () => {
    render();
    await press();
    await waitFor(() => expect(graph.node).not.toBeNull());
    expect(graph.ctx?.options.sampleRate).toBe(8000);
  });

  it("connects capture through a muted gain to the destination", async () => {
    // BOTH halves matter and they pull in opposite directions. Without the
    // connection to the destination the graph may never be pulled and the capture
    // silently never runs; with it, anything the node emitted would come out of the
    // operator's own speakers and back into the microphone.
    render();
    await press();
    await waitFor(() => expect(graph.gain).not.toBeNull());
    expect(graph.source?.connected).toContain(graph.node);
    expect(graph.node?.connected).toContain(graph.gain);
    expect(graph.gain?.connected).toContain(graph.ctx?.destination);
    expect(graph.gain?.gain.value).toBe(0);
  });

  it("retires the processor and stops the microphone on release", async () => {
    render();
    await press();
    await waitFor(() => expect(graph.node).not.toBeNull());
    await release();
    await waitFor(() => expect(graph.tracks.every((t) => t.stopped)).toBe(true));
    expect(graph.node?.port.posted).toContain("stop");
    expect(graph.node?.disconnected).toBe(true);
    expect(graph.gain?.disconnected).toBe(true);
  });
});

describe("a recorder that refuses", () => {
  it("never opens the microphone", async () => {
    // "This camera cannot receive talk-back" is an answer, and it arrives before
    // any permission prompt — so the operator is not asked for a microphone that
    // was never going to be used.
    installAudio();
    render(() => {
      throw new Error("no talk-back on this camera");
    });
    await press();
    await waitFor(() => expect(toasts.length).toBe(1));
    expect(graph.ctx).toBeNull();
    expect(
      (globalThis.navigator as unknown as { mediaDevices: { getUserMedia: { mock: { calls: unknown[] } } } })
        .mediaDevices.getUserMedia.mock.calls,
    ).toHaveLength(0);
  });
});
