// The sounds are Web Audio; jsdom has none, so a fake context stands in. What is
// pinned: nothing sounds before the browser allows it and the first click unlocks
// it; the sounds are the security industry's sirens and sounders, clear of the
// signals a building already gives a meaning (SCRUM-327); and a repeat is one
// looping sound that never lands on top of the ring it follows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_SOUNDS,
  DEFAULT_ALERT_SOUND,
  alertLoopTone,
  alertPattern,
  alertSoundState,
  burstLength,
  installAlertSoundUnlock,
  isAlertSoundId,
  playAlertTone,
  renderPattern,
  resetAlertSoundForTests,
  startAlertLoop,
  stopAlertLoop,
  unlockAlertSound,
} from "./alertSound";

interface FakeSource {
  buffer: { length: number } | null;
  loop: boolean;
  at: number | null;
  stopped: boolean;
  gain: number;
}

class FakeContext {
  static made = 0;
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  sampleRate = 8_000;
  destination = {};
  sources: FakeSource[] = [];
  constructor() {
    FakeContext.made += 1;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createGain() {
    const node = { gain: { value: 1 }, connect: (d: unknown) => d };
    return node;
  }
  createDynamicsCompressor() {
    const param = () => ({ value: 0 });
    return { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect: vi.fn() };
  }
  createBufferSource() {
    const src: FakeSource & Record<string, unknown> = {
      buffer: null,
      loop: false,
      at: null,
      stopped: false,
      gain: 0,
      connect: (g: { gain: { value: number } }) => {
        // The gain is set before the source is wired to it.
        queueMicrotask(() => (src.gain = g.gain.value));
        return g;
      },
      disconnect: vi.fn(),
      start: (at: number) => (src.at = at),
      stop: () => (src.stopped = true),
    };
    this.sources.push(src);
    return src;
  }
}

let ctxRef: FakeContext | null = null;

beforeEach(() => {
  resetAlertSoundForTests();
  FakeContext.made = 0;
  vi.stubGlobal(
    "AudioContext",
    class extends FakeContext {
      constructor() {
        super();
        ctxRef = this as FakeContext;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctxRef = null;
});

describe("the alert tone", () => {
  it("does not sound before the browser allows it, and says so", () => {
    expect(playAlertTone("alarm", 70)).toBe(false);
    expect(startAlertLoop("critical", 70)).toBe(false);
    expect(alertSoundState()).toBe("blocked");
  });

  it("sounds once unlocked", async () => {
    expect(await unlockAlertSound()).toBe(true);
    expect(alertSoundState()).toBe("ready");
    expect(playAlertTone("alarm", 70)).toBe(true);
    expect(ctxRef!.sources).toHaveLength(1);
    expect(ctxRef!.sources[0].loop).toBe(false);
  });

  it("makes no sound at zero volume", async () => {
    await unlockAlertSound();
    playAlertTone("critical", 0);
    startAlertLoop("critical", 0);
    expect(ctxRef!.sources).toHaveLength(0);
  });

  it("rings a critical louder than an alarm", async () => {
    await unlockAlertSound();
    playAlertTone("alarm", 100, "yelp");
    playAlertTone("critical", 100, "yelp");
    await Promise.resolve();
    const [alarm, critical] = ctxRef!.sources;
    expect(critical.gain).toBeGreaterThan(alarm.gain);
  });

  it("unlocks on the operator's first click anywhere, once", async () => {
    const remove = installAlertSoundUnlock();
    window.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(alertSoundState()).toBe("ready"));
    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeContext.made).toBe(1);
    remove();
  });

  it("says when the browser has no Web Audio at all", async () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(await unlockAlertSound()).toBe(false);
    expect(alertSoundState()).toBe("unsupported");
  });
});

describe("the security industry's own sounds (SCRUM-327)", () => {
  const RATE = 8_000;
  const render = (id: string) => renderPattern(alertPattern(id), RATE);

  it("offers the sirens and sounders a site already knows, and no medical or chat sounds", () => {
    expect(ALERT_SOUNDS.map((s) => s.id)).toEqual(["yelp", "warble", "horn", "hilo", "bell", "whoop", "wail"]);
    expect(isAlertSoundId("pulse")).toBe(false);
    expect(isAlertSoundId("chime")).toBe(false);
  });

  it("rings a yelp for a critical and a hi-lo for an alarm by default — two different sounds", () => {
    expect(DEFAULT_ALERT_SOUND).toEqual({ critical: "yelp", alarm: "hilo" });
    // An old or unknown pick falls back to the priority's default.
    expect(alertPattern("pulse", "critical")).toBe(alertPattern("yelp"));
    expect(alertPattern("chime", "alarm")).toBe(alertPattern("hilo"));
  });

  it("sweeps the yelp 500–1500 Hz three times a second, the siren's own range and pace", () => {
    const [n] = alertPattern("yelp").notes;
    expect(n.freq - (n.sweep?.depth ?? 0)).toBe(500);
    expect(n.freq + (n.sweep?.depth ?? 0)).toBe(1500);
    expect(n.sweep?.rate).toBe(3);
  });

  it("keeps clear of signals a building already gives a meaning", () => {
    // Hi-lo in half-second steps: a quarter-second hi-lo is a UK fire tone.
    expect(alertPattern("hilo").notes.every((n) => n.dur === 0.5)).toBe(true);
    // A whoop that rises in under a second: a 3.5 s whoop is evacuation (NEN 2575).
    expect(alertPattern("whoop").notes.every((n) => n.dur < 1)).toBe(true);
    // No sound of three or four pulses before a gap: Temporal-3 is fire, Temporal-4
    // CO. A pulse is sound between silences; notes that run on into each other (the
    // hi-lo's steps, the bell's strikes) are one.
    const pulses = (id: string) => {
      const notes = [...alertPattern(id).notes].sort((a, b) => a.at - b.at);
      let count = 0;
      let end = -1;
      for (const n of notes) {
        if (n.at > end + 0.02) count += 1;
        end = Math.max(end, n.at + n.dur);
      }
      return count;
    };
    for (const { id } of ALERT_SOUNDS) expect([3, 4]).not.toContain(pulses(id));
    expect(pulses("horn")).toBe(5);
  });

  it("renders every sound as a burst then silence, at full scale and never past it", () => {
    for (const { id } of ALERT_SOUNDS) {
      const p = alertPattern(id);
      const out = render(id);
      expect(out.length).toBe(Math.ceil(p.cycle * RATE));
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
      const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak).toBeCloseTo(1, 5);
      // After the burst: nothing, until the next turn.
      const tail = out.subarray(Math.ceil((burstLength(p) + 0.01) * RATE));
      expect(tail.every((v) => v === 0)).toBe(true);
      // Soft edges: the first sample is silence, not a click.
      expect(Math.abs(out[0])).toBeLessThan(0.01);
    }
  });

  it("builds the horn's roughness from two tones beating 4 Hz apart", () => {
    const first = alertPattern("horn").notes.filter((n) => n.at === 0).map((n) => n.freq);
    expect(first).toEqual([400, 404]);
  });
});

describe("repeat until answered (SCRUM-327)", () => {
  it("is one looping sound, stopped on answer", async () => {
    await unlockAlertSound();
    expect(startAlertLoop("critical", 70)).toBe(true);
    const [src] = ctxRef!.sources;
    expect(src.loop).toBe(true);
    expect(alertLoopTone()).toBe("critical");

    stopAlertLoop();
    expect(src.stopped).toBe(true);
    expect(alertLoopTone()).toBeNull();
  });

  it("follows the ring it continues by one turn, never on top of it", async () => {
    await unlockAlertSound();
    playAlertTone("critical", 70);
    startAlertLoop("critical", 70);
    const [ring, repeat] = ctxRef!.sources;
    expect(repeat.at! - ring.at!).toBeCloseTo(alertPattern(DEFAULT_ALERT_SOUND.critical).cycle, 5);
  });

  it("starts straight after a ring of another priority ends", async () => {
    await unlockAlertSound();
    playAlertTone("alarm", 70);
    startAlertLoop("critical", 70);
    const [ring, repeat] = ctxRef!.sources;
    const alarm = alertPattern(DEFAULT_ALERT_SOUND.alarm);
    expect(repeat.at! - ring.at!).toBeGreaterThanOrEqual(burstLength(alarm));
    expect(repeat.at! - ring.at!).toBeLessThan(alarm.cycle);
  });

  it("is the ring while it runs: a new alarm of its priority or below adds no second sound", async () => {
    await unlockAlertSound();
    startAlertLoop("critical", 70);
    expect(playAlertTone("critical", 70)).toBe(true);
    expect(playAlertTone("alarm", 70)).toBe(true);
    expect(ctxRef!.sources).toHaveLength(1);
  });

  it("lets a critical ring over a repeating alarm", async () => {
    await unlockAlertSound();
    startAlertLoop("alarm", 70);
    playAlertTone("critical", 70);
    expect(ctxRef!.sources).toHaveLength(2);
  });

  it("lets a test play over a repeat", async () => {
    await unlockAlertSound();
    startAlertLoop("critical", 70);
    playAlertTone("alarm", 70, "bell", { preview: true });
    expect(ctxRef!.sources).toHaveLength(2);
  });

  it("replaces one repeat with the next", async () => {
    await unlockAlertSound();
    startAlertLoop("alarm", 70);
    startAlertLoop("critical", 70);
    const [first, second] = ctxRef!.sources;
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
    expect(alertLoopTone()).toBe("critical");
  });
});
