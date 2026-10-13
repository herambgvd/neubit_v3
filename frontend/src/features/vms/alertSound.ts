"use client";

// THE ALARM SOUNDS — what an operator hears when an alarm arrives (SCRUM-326, SCRUM-327).
//
// Every alarm console sounds its alarms: Milestone plays a sound per alarm priority
// and can repeat it until the alarm is looked at, Genetec plays once, every n
// seconds or continuously, HikCentral rings on an ANPR block-list hit. A console
// that only paints a card is missed by the operator looking at the other monitor.
//
// THEY ARE THE SECURITY INDUSTRY'S OWN SOUNDS — the tones of the sirens and sounders
// a site already has on its walls (E2S, Pfannenberg and Federal Signal tone tables),
// not a chat app's chime and not a medical monitor's pulses:
//   * Siren (yelp) — the intruder / vehicle siren's fast 500–1500 Hz sweep. The most
//     urgent of them (yelp is the siren that gets attention), so a critical's default;
//   * Two-tone hi-lo — 1000 / 800 Hz, half a second each. An alarm's default;
//   * Rising whoop — a fast 500 → 1200 Hz rise, twice;
//   * Intruder warble — the bell-box piezo siren's 2.4–2.9 kHz warble;
//   * Horn — an interrupted klaxon, rough at 400 Hz, for a door forced or held;
//   * Electronic bell — a rapid ring;
//   * Wail — the slow siren, for an operator who wants the least urgent.
// Each is band-limited and harmonic-rich (a sawtooth, square or triangle built from
// its harmonics through a 12 dB/octave low-pass), so it carries through a noisy room
// without the harsh aliasing of a raw oscillator; every edge is a 10–30 ms ramp, so nothing
// clicks or startles.
//
// SOME SOUNDS ARE KEPT OUT ON PURPOSE, because a building already gives them a
// meaning: Temporal-3 (three pulses, then a gap) is fire evacuation (ISO 8201 /
// NFPA 72) and Temporal-4 is carbon monoxide; a slow 3.5 s whoop is evacuation in the
// Netherlands and Australia (NEN 2575, AS 2220); a quarter-second hi-lo is a UK fire
// tone (BS 5839-1); a long steady tone is the all-clear in Nordic and German codes.
// So the hi-lo keeps half-second steps, the whoop rises in under a second, and no
// pulsed sound stops after three or four.
//
// The operator picks a sound per priority; picking different ones lets the ear tell a
// critical from an alarm before the eye does. A critical also rings a little louder.
//
// They are synthesised here, sample by sample, not played from files: the console
// runs air-gapped and ships no audio assets, and a synthesised sound needs no fetch
// at the moment it matters.
//
// THE RING LASTS AS LONG AS THE POP-UP (SCRUM-327): an alarm on screen is still
// waiting, and it keeps sounding until it is answered, silenced, or its pop-up
// closes. That repeat is one looping buffer — the burst and the short silence after
// it — not a timer that replays the burst. A background tab's timers are throttled
// and its alarms would ring late; a looping source is scheduled by the audio clock
// and rings on time until it is stopped.
//
// Browsers only let a page make sound after the person has interacted with it
// (autoplay policy). The first click or key anywhere in the console unlocks the sound
// for the session; until then playAlertTone reports "blocked" and the alarm pop-up
// offers an "Enable sound" button, which is that interaction.

export type AlertTone = "critical" | "alarm";
export type AlertSoundState = "ready" | "blocked" | "unsupported";
/** The built-in security sounds an operator can pick for a priority. */
export type AlertSoundId = "yelp" | "hilo" | "whoop" | "warble" | "horn" | "bell" | "wail";

/** Yelp for a critical, hi-lo for an alarm: two different sounds, the more urgent
 *  one where it belongs. */
export const DEFAULT_ALERT_SOUND: Record<AlertTone, AlertSoundId> = { critical: "yelp", alarm: "hilo" };

/** The menu, most urgent first. */
export const ALERT_SOUNDS: readonly { id: AlertSoundId; label: string }[] = [
  { id: "yelp", label: "Siren (yelp)" },
  { id: "warble", label: "Intruder siren (warble)" },
  { id: "horn", label: "Horn (klaxon)" },
  { id: "hilo", label: "Two-tone hi-lo (slow)" },
  { id: "bell", label: "Electronic bell" },
  { id: "whoop", label: "Rising whoop" },
  { id: "wail", label: "Wail (slow siren)" },
];

export function isAlertSoundId(v: unknown): v is AlertSoundId {
  return ALERT_SOUNDS.some((s) => s.id === v);
}

/** How a note sounds: a band-limited classic waveform, or a bell's own partials. */
type Voice =
  | { kind: "saw" | "square" | "triangle"; cutoff: number }
  | { kind: "partials"; partials: readonly { mul: number; amp: number }[] };

/** One note: when, how long, a pitch and how it moves, and its envelope. */
interface Note {
  at: number;
  dur: number;
  /** Hz at the start (a glide), or the centre of a sweep. */
  freq: number;
  /** Hz at the end of a glide. */
  to?: number;
  /** An exponential glide — a whoop rises the way the ear hears pitch. */
  expo?: boolean;
  /** A siren's sweep around `freq`: rate (Hz) and depth (Hz), starting at the bottom. */
  sweep?: { rate: number; depth: number };
  voice: Voice;
  rise: number;
  /** A linear fade at the end, or a bell's exponential decay (time constant). */
  fall: number;
  decay?: number;
}

export interface AlertPattern {
  notes: readonly Note[];
  /** The burst and the silence after it: one turn of the repeat, in seconds. */
  cycle: number;
  /** Relative loudness, so the sounds feel alike in level: a 2.6 kHz piezo warble
   *  is far louder to the ear than a 400 Hz horn at the same peak. */
  level: number;
}

const saw = (cutoff: number): Voice => ({ kind: "saw", cutoff });
const square = (cutoff: number): Voice => ({ kind: "square", cutoff });

const repeat = (count: number, every: number, note: (at: number, i: number) => Note | Note[]): Note[] =>
  Array.from({ length: count }, (_, i) => note(i * every, i)).flat();

const PATTERNS: Record<AlertSoundId, AlertPattern> = {
  // A sawtooth swept 500 → 1500 → 500 Hz three times a second, for 2 s; then 1 s.
  yelp: {
    notes: [{ at: 0, dur: 2, freq: 1000, sweep: { rate: 3, depth: 500 }, voice: saw(3500), rise: 0.02, fall: 0.03 }],
    cycle: 3,
    level: 0.9,
  },
  // A triangle warbling 2400 ↔ 2900 Hz seven times a second, as a bell-box siren does.
  warble: {
    notes: [
      { at: 0, dur: 1.5, freq: 2650, sweep: { rate: 7, depth: 250 }, voice: { kind: "triangle", cutoff: 9000 }, rise: 0.02, fall: 0.03 },
    ],
    cycle: 3,
    level: 0.5,
  },
  // Two sawtooths 4 Hz apart beat into a klaxon's roughness: 300 ms on, 150 ms off, five times.
  horn: {
    notes: repeat(5, 0.45, (at) => [
      { at, dur: 0.3, freq: 400, voice: saw(2000), rise: 0.01, fall: 0.015 },
      { at, dur: 0.3, freq: 404, voice: saw(2000), rise: 0.01, fall: 0.015 },
    ]),
    cycle: 3.75,
    level: 1,
  },
  // 1000 / 800 Hz, half a second each, twice; then 2 s. Half-second steps: a
  // quarter-second hi-lo is a UK fire tone.
  hilo: {
    notes: repeat(4, 0.5, (at, i) => ({ at, dur: 0.5, freq: i % 2 ? 800 : 1000, voice: square(3000), rise: 0.01, fall: 0.01 })),
    cycle: 4,
    level: 0.8,
  },
  // Strikes twenty times a second, each a bell's three partials decaying fast.
  bell: {
    notes: repeat(40, 0.05, (at) => ({
      at,
      dur: 0.15,
      freq: 1100,
      voice: {
        kind: "partials",
        partials: [
          { mul: 1, amp: 1 },
          { mul: 2700 / 1100, amp: 0.5 },
          { mul: 4300 / 1100, amp: 0.25 },
        ],
      },
      rise: 0.001,
      fall: 0.01,
      decay: 0.03,
    })),
    cycle: 3,
    level: 0.8,
  },
  // A fast rise 500 → 1200 Hz in 0.8 s, twice. Never the slow 3.5 s evacuation whoop.
  whoop: {
    notes: repeat(2, 1, (at) => ({ at, dur: 0.8, freq: 500, to: 1200, expo: true, voice: saw(3000), rise: 0.02, fall: 0.03 })),
    cycle: 3.5,
    level: 0.9,
  },
  // The slow siren: 500 → 1500 → 500 Hz over 3 s; then 2 s.
  wail: {
    notes: [{ at: 0, dur: 3, freq: 1000, sweep: { rate: 1 / 3, depth: 500 }, voice: saw(3500), rise: 0.03, fall: 0.05 }],
    cycle: 5,
    level: 0.9,
  },
};

/** A sound's pattern; an unknown pick is the priority's default. */
export function alertPattern(id: string | undefined, tone: AlertTone = "alarm"): AlertPattern {
  return isAlertSoundId(id) ? PATTERNS[id] : PATTERNS[DEFAULT_ALERT_SOUND[tone]];
}

/** Where the sound of a pattern ends and its silence begins. */
export function burstLength(p: AlertPattern): number {
  return Math.max(...p.notes.map((n) => n.at + n.dur));
}

/** −1…1, period 1, starting at the bottom. */
const triangle = (x: number) => 2 * Math.abs(2 * (x - Math.floor(x + 0.5))) - 1;

function noteFreq(n: Note, t: number): number {
  if (n.to !== undefined) {
    const k = t / n.dur;
    return n.expo ? n.freq * (n.to / n.freq) ** k : n.freq + (n.to - n.freq) * k;
  }
  if (n.sweep) return n.freq + n.sweep.depth * triangle(n.sweep.rate * t);
  return n.freq;
}

/** Linear ramps in and out — exponential ones never reach silence, and a step
 *  clicks — or, for a bell, a strike that dies away. */
function envelope(n: Note, t: number): number {
  if (t < n.rise) return t / n.rise;
  const left = n.dur - t;
  const tail = left < n.fall ? Math.max(0, left / n.fall) : 1;
  return n.decay ? Math.exp(-(t - n.rise) / n.decay) * tail : tail;
}

/** A 12 dB/octave low-pass, as a sounder's horn and a filter give: the harmonics
 *  past the cutoff are softened, not cut off, so a square stays a square. Nothing
 *  is built at or past `top` (just under Nyquist), and the last of it fades in
 *  smoothly, so a sweep gains and loses harmonics without a step. */
const lowpass = (hz: number, cutoff: number, top: number) => {
  if (hz >= top) return 0;
  const edge = Math.min(1, (top - hz) / (top * 0.2));
  return edge / Math.sqrt(1 + (hz / cutoff) ** 4);
};

/** The highest harmonic built: well inside Nyquist, and no further past the cutoff
 *  than the ear can still hear it (two octaves, 24 dB down). */
const topHz = (rate: number, v: Voice) => Math.min(10_000, rate * 0.45, v.kind === "partials" ? 10_000 : v.cutoff * 4);

/** The weight of odd harmonic `k`: a square's falls as 1/k; a triangle's as 1/k²,
 *  with alternating sign. */
function oddAmp(kind: "square" | "triangle", k: number): number {
  if (kind === "square") return 1 / k;
  const sign = ((k - 1) / 2) % 2 ? -1 : 1;
  return sign / (k * k);
}

/** One sample of a voice at phase `phase` (radians) and pitch `f`. */
function voiceSample(v: Voice, phase: number, f: number, top: number): number {
  if (v.kind === "partials") {
    let s = 0;
    for (const p of v.partials) s += p.amp * Math.sin(p.mul * phase);
    return s;
  }
  let s = 0;
  for (let k = 1; k * f < top; k += 1) {
    const w = lowpass(k * f, v.cutoff, top);
    if (v.kind === "saw") s += (w / k) * Math.sin(k * phase);
    else if (k % 2 === 1) s += w * oddAmp(v.kind, k) * Math.sin(k * phase);
  }
  return s;
}

function renderNote(out: Float32Array, n: Note, rate: number): void {
  const start = Math.round(n.at * rate);
  const len = Math.min(Math.round(n.dur * rate), out.length - start);
  const top = topHz(rate, n.voice);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const t = i / rate;
    const f = noteFreq(n, t);
    // The phase accumulates, so a glide or a sweep changes pitch without a jump.
    phase += (2 * Math.PI * f) / rate;
    out[start + i] += voiceSample(n.voice, phase, f, top) * envelope(n, t);
  }
}

/** One turn of a pattern as samples, peak-normalised to 1. */
export function renderPattern(p: AlertPattern, rate: number): Float32Array {
  const out = new Float32Array(Math.ceil(p.cycle * rate));
  for (const n of p.notes) renderNote(out, n, rate);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] /= peak;
  return out;
}

type Ctx = AudioContext;
type CtxCtor = new () => Ctx;

const RANK: Record<AlertTone, number> = { critical: 2, alarm: 1 };
/** A critical a little louder than an alarm (−3 dB). */
const TONE_LEVEL: Record<AlertTone, number> = { critical: 1, alarm: 0.71 };
/** The loudest a sound gets at volume 100, before its own and its priority's level. */
const FULL_SCALE = 0.8;

let ctx: Ctx | null = null;
let state: AlertSoundState = "blocked";
let limiter: AudioNode | null = null;
const buffers = new Map<string, AudioBuffer>();
let loop: { src: AudioBufferSourceNode; tone: AlertTone } | null = null;
/** The last one-off ring, so a repeat that follows it keeps its rhythm. */
let lastShot: { id: AlertSoundId; at: number } | null = null;
const listeners = new Set<() => void>();

function ctor(): CtxCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: CtxCtor; webkitAudioContext?: CtxCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function setState(next: AlertSoundState) {
  if (state === next) return;
  state = next;
  for (const fn of listeners) fn();
}

/** Whether a sound can play right now. */
export function alertSoundState(): AlertSoundState {
  if (!ctor()) return "unsupported";
  if (ctx?.state === "running") return "ready";
  return state;
}

export function subscribeAlertSound(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Create or resume the audio context. Call from a user gesture. */
export async function unlockAlertSound(): Promise<boolean> {
  const C = ctor();
  if (!C) {
    setState("unsupported");
    return false;
  }
  try {
    ctx ??= new C();
    if (ctx.state !== "running") await ctx.resume();
    setState(ctx.state === "running" ? "ready" : "blocked");
  } catch {
    setState("blocked");
  }
  return state === "ready";
}

/** Unlock on the first click or key anywhere, once. Returns the uninstall. */
export function installAlertSoundUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const unlock = () => {
    void unlockAlertSound().then((ok) => {
      if (ok) remove();
    });
  };
  const remove = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return remove;
}

/** A limiter in front of the speakers: a ring over a repeat never clips. Set just
 *  under full scale, so it only catches an overlap and leaves the step in loudness
 *  between a critical and an alarm alone. */
function output(c: Ctx): AudioNode {
  if (limiter) return limiter;
  const lim = c.createDynamicsCompressor();
  lim.threshold.value = -2;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.001;
  lim.release.value = 0.1;
  lim.connect(c.destination);
  limiter = lim;
  return lim;
}

function bufferFor(c: Ctx, id: AlertSoundId): AudioBuffer {
  const key = `${id}:${c.sampleRate}`;
  const hit = buffers.get(key);
  if (hit) return hit;
  const data = renderPattern(PATTERNS[id], c.sampleRate);
  const buf = c.createBuffer(1, data.length, c.sampleRate);
  buf.getChannelData(0).set(data);
  buffers.set(key, buf);
  return buf;
}

/** Build these sounds now, so the first alarm rings at once instead of after the
 *  tenth of a second it takes to synthesise one. Only once the browser lets us. */
export function prepareAlertSounds(ids: readonly AlertSoundId[]): void {
  if (ctx?.state !== "running") return;
  for (const id of ids) bufferFor(ctx, id);
}

function voice(c: Ctx, tone: AlertTone, id: AlertSoundId, volume: number, at: number, looping: boolean) {
  const src = c.createBufferSource();
  src.buffer = bufferFor(c, id);
  src.loop = looping;
  const gain = c.createGain();
  gain.gain.value = (Math.min(volume, 100) / 100) * FULL_SCALE * TONE_LEVEL[tone] * PATTERNS[id].level;
  src.connect(gain).connect(output(c));
  src.start(at);
  return src;
}

function running(): Ctx | null {
  if (ctx?.state === "running") return ctx;
  setState(ctor() ? "blocked" : "unsupported");
  return null;
}

const soundOf = (tone: AlertTone, id: AlertSoundId | undefined): AlertSoundId =>
  isAlertSoundId(id) ? id : DEFAULT_ALERT_SOUND[tone];

export interface PlayOptions {
  /** A test from the settings: plays whatever is ringing, and is not a ring. */
  preview?: boolean;
}

/** Ring once: one burst of `tone`'s sound at `volume` (0–100). Returns whether it
 *  could sound. A repeat already ringing at this priority or above is that ring. */
export function playAlertTone(
  tone: AlertTone,
  volume: number,
  id?: AlertSoundId,
  { preview = false }: PlayOptions = {},
): boolean {
  const c = running();
  if (!c) return false;
  if (volume <= 0) return true;
  if (!preview && loop && RANK[loop.tone] >= RANK[tone]) return true;
  const sound = soundOf(tone, id);
  const at = c.currentTime + 0.02;
  voice(c, tone, sound, volume, at, false);
  if (!preview) lastShot = { id: sound, at };
  return true;
}

/** When a repeat starts: a turn after the ring it continues, or straight after a
 *  ring of another sound — never on top of one. */
function repeatStart(now: number, id: AlertSoundId): number {
  const soon = now + 0.02;
  if (!lastShot) return soon;
  const p = PATTERNS[lastShot.id];
  if (lastShot.id === id) return Math.max(soon, lastShot.at + p.cycle);
  return Math.max(soon, lastShot.at + burstLength(p) + 0.3);
}

/** Ring `tone` again and again until stopAlertLoop. One repeat at a time: starting
 *  another replaces it. Returns whether it could sound. */
export function startAlertLoop(tone: AlertTone, volume: number, id?: AlertSoundId): boolean {
  const c = running();
  if (!c) return false;
  stopAlertLoop();
  if (volume <= 0) return true;
  const sound = soundOf(tone, id);
  loop = { src: voice(c, tone, sound, volume, repeatStart(c.currentTime, sound), true), tone };
  return true;
}

export function stopAlertLoop(): void {
  if (!loop) return;
  try {
    loop.src.stop();
  } catch {
    // Never started: nothing to stop.
  }
  loop.src.disconnect();
  loop = null;
}

/** The priority repeating now, if any. */
export function alertLoopTone(): AlertTone | null {
  return loop?.tone ?? null;
}

/** Test seam: forget the context and the state. */
export function resetAlertSoundForTests(): void {
  ctx = null;
  state = "blocked";
  limiter = null;
  loop = null;
  lastShot = null;
  buffers.clear();
  listeners.clear();
}
