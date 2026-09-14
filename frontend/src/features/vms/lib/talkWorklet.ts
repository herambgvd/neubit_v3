// The main-thread half of talk-back capture: what the worklet is called, where it is
// served from, and what "this browser cannot do it" means.
//
// It lives apart from TalkButton for one reason that matters more than tidiness: the
// REFUSAL is the safety property here. An operator who believes the room heard them,
// when the microphone fed nothing, is the dangerous failure — worse than a button
// that plainly does not work. So the checks below are unit-testable on their own,
// rather than reachable only by pressing a button in a browser.

/** The processor name the worklet registers itself under. */
export const TALK_WORKLET_NAME = "talk-capture";

/** Served from `public/`, at a stable unhashed path.
 *
 *  A worklet is fetched by URL and evaluated in its own global scope, so it cannot be
 *  bundled into the React chunk and cannot carry a content hash that the bundler
 *  rewrites — the URL has to be one this file can name literally. */
export const TALK_WORKLET_URL = "/audio/talk-capture-worklet.js";

/** 8 kHz mono is G.711's rate; capturing straight into an 8 kHz AudioContext lets the
 *  browser resample the mic (usually 48 kHz) for us, so there is no hand-rolled
 *  resampler here to get wrong. */
export const TALK_SAMPLE_RATE = 8000;

/** 160 samples = 20 ms at 8 kHz, exactly the ptime the recorder's packetizer
 *  re-frames to. The worklet accumulates the fixed 128-sample render quanta up to
 *  this. Duplicated as FRAME_SAMPLES inside the worklet, which cannot import from
 *  here; talkWorklet.test.ts asserts the two agree. */
export const TALK_FRAME_SAMPLES = 160;

/** Whether this browser can capture audio for talk-back at all.
 *
 *  Checked BEFORE the recorder is asked to begin a session, so a browser that cannot
 *  talk never books one or writes the audit record for a talkspurt that never
 *  happened. Probed by name rather than by constructing anything, so the check costs
 *  nothing and cannot itself fail. */
export function canCaptureTalk(): boolean {
  return (
    typeof AudioContext === "function" &&
    typeof AudioWorkletNode === "function" &&
    "audioWorklet" in AudioContext.prototype
  );
}

/** Load the worklet module into `ctx` and build the capture node.
 *
 *  `addModule` is a network fetch, and it fails for reasons that have nothing to do
 *  with the browser's capabilities: the file missing from a bad deploy, a proxy
 *  serving HTML for it, an offline appliance. Every one of those has to reach the
 *  caller as a refusal rather than a node that exists and never fires — which is why
 *  this rejects instead of returning null.
 *
 *  `numberOfOutputs: 1` even though nothing is ever written to it: the node is
 *  connected through a muted gain to the destination, which is what guarantees the
 *  graph is pulled on every browser. A node with no outputs is not reliably
 *  processed, and "the capture silently never ran" is the exact failure this whole
 *  file exists to prevent. */
export async function createTalkCaptureNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule(TALK_WORKLET_URL);
  return new AudioWorkletNode(ctx, TALK_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
}
