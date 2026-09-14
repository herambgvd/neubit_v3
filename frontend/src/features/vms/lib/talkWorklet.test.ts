/**
 * Talk-back capture: the refusal rules, and the worklet that actually runs.
 *
 * The capture leg moved off ScriptProcessorNode — which ran the Float32→PCM16
 * conversion on the MAIN thread, so every React render competed with the operator's
 * voice — onto an AudioWorklet. Two classes of property are worth holding:
 *
 *   * REFUSAL. An operator who believes the room heard them, when the microphone fed
 *     nothing, is the dangerous failure. A browser that cannot do this, or a deploy
 *     that did not ship the worklet, has to reach the caller as an error.
 *   * FRAMING AND ENCODING. `process()` gets fixed 128-sample quanta; the recorder
 *     wants 160-sample (20 ms) frames of little-endian PCM16. The boundary between
 *     those two is arithmetic nobody should have to re-derive from a browser.
 *
 * The worklet is not imported — it is READ FROM public/ AND EVALUATED, so what these
 * tests drive is the same bytes the browser is served. A test against a copy of that
 * logic in src/ would keep passing after the shipped file drifted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TALK_FRAME_SAMPLES,
  TALK_SAMPLE_RATE,
  TALK_WORKLET_NAME,
  TALK_WORKLET_URL,
  canCaptureTalk,
  createTalkCaptureNode,
} from "./talkWorklet";

const WORKLET_FILE = join(__dirname, "../../../../public/audio/talk-capture-worklet.js");

/** Load the shipped worklet in a stand-in for the AudioWorkletGlobalScope and hand
 *  back the processor class it registered. */
function loadWorklet(): { new (): { port: FakePort; process(inputs: Float32Array[][]): boolean } } {
  const source = readFileSync(WORKLET_FILE, "utf8");
  let registered: string | null = null;
  let cls: unknown = null;
  class FakeAudioWorkletProcessor {
    port = new FakePort();
  }
  const run = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    `${source}\n`,
  );
  run(FakeAudioWorkletProcessor, (name: string, klass: unknown) => {
    registered = name;
    cls = klass;
  });
  expect(registered, "the worklet must register itself under the name the app asks for")
    .toBe(TALK_WORKLET_NAME);
  return cls as never;
}

class FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  posted: Uint8Array[] = [];
  postMessage(data: Uint8Array, transfer?: unknown[]) {
    // Copy: the real port TRANSFERS the buffer, so the worklet's own reference is
    // detached afterwards. Keeping a live reference here would let a test pass
    // against a worklet that reuses one buffer for every frame.
    expect(transfer, "frames must be transferred, not copied").toEqual([data.buffer]);
    this.posted.push(new Uint8Array(data));
  }
  send(data: unknown) {
    this.onmessage?.({ data });
  }
}

/** `n` render quanta of 128 samples, all at `value`. Each element is one `inputs`
 *  argument: inputs[inputIndex][channelIndex] is the channel's samples. */
function quanta(n: number, value = 0.5): Float32Array[][][] {
  return Array.from({ length: n }, () => [[new Float32Array(128).fill(value)]]);
}

describe("canCaptureTalk", () => {
  const realCtx = globalThis.AudioContext;
  const realNode = (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;

  afterEach(() => {
    if (realCtx) globalThis.AudioContext = realCtx;
    else delete (globalThis as { AudioContext?: unknown }).AudioContext;
    if (realNode) (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = realNode;
    else delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  });

  function withEnv(opts: { ctx?: boolean; node?: boolean; worklet?: boolean }) {
    if (opts.ctx === false) {
      delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
      class Ctx {}
      if (opts.worklet !== false) (Ctx.prototype as Record<string, unknown>).audioWorklet = {};
      (globalThis as { AudioContext?: unknown }).AudioContext = Ctx;
    }
    if (opts.node === false) delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    else (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {};
  }

  it("accepts a browser that has all three pieces", () => {
    withEnv({});
    expect(canCaptureTalk()).toBe(true);
  });

  it("refuses a browser with no AudioContext", () => {
    withEnv({ ctx: false });
    expect(canCaptureTalk()).toBe(false);
  });

  it("refuses a browser with no AudioWorkletNode", () => {
    withEnv({ node: false });
    expect(canCaptureTalk()).toBe(false);
  });

  it("refuses an AudioContext that cannot load worklets", () => {
    // Older Safari shipped AudioContext long before `audioWorklet` on it. Probing
    // only for the constructor would report such a browser as able to talk.
    withEnv({ worklet: false });
    expect(canCaptureTalk()).toBe(false);
  });
});

describe("createTalkCaptureNode", () => {
  const realNode = (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  let built: { name: string; options: Record<string, unknown> } | null = null;

  beforeEach(() => {
    built = null;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {
      constructor(_ctx: unknown, name: string, options: Record<string, unknown>) {
        built = { name, options };
      }
    };
  });

  afterEach(() => {
    if (realNode) (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = realNode;
    else delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  });

  const ctxWith = (addModule: (url: string) => Promise<void>) =>
    ({ audioWorklet: { addModule } }) as unknown as AudioContext;

  it("loads the worklet from the unhashed public path", async () => {
    const addModule = vi.fn().mockResolvedValue(undefined);
    await createTalkCaptureNode(ctxWith(addModule));
    expect(addModule).toHaveBeenCalledWith(TALK_WORKLET_URL);
    expect(TALK_WORKLET_URL.startsWith("/")).toBe(true);
  });

  it("rejects when the worklet cannot be fetched", async () => {
    // A bad deploy, a proxy answering with HTML, an offline appliance. None of those
    // are a browser capability, and every one of them has to reach the caller — a
    // node that exists and never fires is the failure this path exists to prevent.
    const addModule = vi.fn().mockRejectedValue(new Error("404"));
    await expect(createTalkCaptureNode(ctxWith(addModule))).rejects.toThrow("404");
  });

  it("gives the node an output, because a node with none is not reliably pulled", async () => {
    await createTalkCaptureNode(ctxWith(vi.fn().mockResolvedValue(undefined)));
    expect(built?.name).toBe(TALK_WORKLET_NAME);
    expect(built?.options.numberOfOutputs).toBe(1);
    expect(built?.options.numberOfInputs).toBe(1);
    expect(built?.options.channelCount).toBe(1);
  });
});

describe("the shipped worklet", () => {
  it("frames 20 ms at the rate the app captures at", () => {
    // 160 samples at 8 kHz is 20 ms — the recorder's packetizer ptime. If either
    // constant moves without the other, the frames stop being 20 ms.
    expect(TALK_FRAME_SAMPLES / TALK_SAMPLE_RATE).toBeCloseTo(0.02, 6);
  });

  it("uses the same frame size the app declares", () => {
    // The worklet cannot import from src/, so the number is written twice. This is
    // the assertion that keeps the two copies honest.
    const source = readFileSync(WORKLET_FILE, "utf8");
    const declared = /FRAME_SAMPLES\s*=\s*(\d+)/.exec(source);
    expect(declared?.[1]).toBe(String(TALK_FRAME_SAMPLES));
  });

  it("emits nothing until a whole frame has arrived", () => {
    // 128 < 160, so one quantum is not yet a frame. A worklet that posted the
    // partial buffer would send the recorder short frames forever.
    const P = loadWorklet();
    const p = new P();
    expect(p.process(quanta(1)[0])).toBe(true);
    expect(p.port.posted).toHaveLength(0);
  });

  it("accumulates 128-sample quanta into 160-sample frames", () => {
    // 10 quanta = 1280 samples = exactly 8 frames of 160. The boundary never lands
    // on a quantum edge, so this also covers carrying a partial frame across calls.
    const P = loadWorklet();
    const p = new P();
    for (const q of quanta(10)) p.process(q);
    expect(p.port.posted).toHaveLength(8);
    for (const frame of p.port.posted) {
      expect(frame.byteLength).toBe(TALK_FRAME_SAMPLES * 2);
    }
  });

  it("loses no samples across the frame boundary", () => {
    // A ramp, so every sample is distinguishable: whatever went in must come out in
    // order. An off-by-one in the accumulator shows up here and nowhere else.
    const P = loadWorklet();
    const p = new P();
    const sent: number[] = [];
    for (let q = 0; q < 10; q++) {
      const buf = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        const v = ((q * 128 + i) % 1000) / 2000; // 0 … 0.4995
        buf[i] = v;
        sent.push(v);
      }
      p.process([[buf]]);
    }
    const got: number[] = [];
    for (const frame of p.port.posted) {
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      for (let i = 0; i < frame.byteLength / 2; i++) got.push(view.getInt16(i * 2, true));
    }
    expect(got).toHaveLength(8 * TALK_FRAME_SAMPLES);
    for (let i = 0; i < got.length; i++) {
      // `setInt16` TRUNCATES toward zero rather than rounding — matching the
      // worklet's actual arithmetic, not an idealised version of it.
      expect(got[i]).toBe(Math.trunc(sent[i] * 0x7fff));
    }
  });

  it("does not clip the loudest negative sample", () => {
    // Full scale is asymmetric: -1 maps to -32768, and scaling it by 0x7fff instead
    // would quietly distort the loudest part of an operator's voice.
    const P = loadWorklet();
    const p = new P();
    for (let q = 0; q < 2; q++) p.process([[new Float32Array(128).fill(-1)]]);
    const frame = p.port.posted[0];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getInt16(0, true)).toBe(-32768);
  });

  it("clamps samples outside [-1, 1]", () => {
    const P = loadWorklet();
    const p = new P();
    for (let q = 0; q < 2; q++) p.process([[new Float32Array(128).fill(4)]]);
    const frame = p.port.posted[0];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getInt16(0, true)).toBe(32767);
  });

  it("stays alive through a quantum with no input", () => {
    // The mic has not started, or the source was momentarily disconnected. Returning
    // false there would end the capture permanently on a gap.
    const P = loadWorklet();
    const p = new P();
    expect(p.process([[]])).toBe(true);
    expect(p.process([])).toBe(true);
  });

  it("retires when told to stop", () => {
    const P = loadWorklet();
    const p = new P();
    p.port.send("stop");
    expect(p.process(quanta(1)[0])).toBe(false);
  });

  it("ignores messages that are not stop", () => {
    const P = loadWorklet();
    const p = new P();
    p.port.send("something else");
    expect(p.process(quanta(1)[0])).toBe(true);
  });

  it("never writes to its output", () => {
    // THE ANTI-FEEDBACK GUARD, half of it. Anything emitted here reaches the
    // destination and comes back out of the operator's own speakers, into the
    // microphone. The muted gain in TalkButton is the other half.
    const P = loadWorklet();
    const p = new P();
    const outputs = [[new Float32Array(128)]];
    for (const q of quanta(4)) (p.process as (i: unknown, o: unknown) => boolean)(q, outputs);
    expect(Array.from(outputs[0][0]).every((v) => v === 0)).toBe(true);
  });
});
