// TALK-BACK CAPTURE, ON THE AUDIO THREAD.
//
// Loaded by TalkButton via `ctx.audioWorklet.addModule('/audio/talk-capture-worklet.js')`.
// It replaces a ScriptProcessorNode, which ran this same conversion on the MAIN
// thread — so every React render competed with the operator's voice, and under UI
// load the capture dropped frames. That was true before the deprecation and is the
// reason to move, not merely that the node is being removed from browsers.
//
// WHY THIS FILE IS NOT IN src/. A worklet is fetched by URL and evaluated in its own
// global scope: no `window`, no `document`, and nothing from the React bundle. It has
// to be served as a real file at a stable, unhashed path, which under Next means
// `public/`. Its behaviour is still covered — features/vms/lib/talkWorklet.test.ts
// loads THIS file and drives `process()` directly, so the tested code and the shipped
// code are the same bytes.
//
// FRAMING. `process()` is handed fixed 128-sample render quanta, so the old
// PROCESSOR_BUFFER choice is gone. Samples are accumulated to 160 instead, which at
// 8 kHz is exactly the 20 ms the recorder's packetizer re-frames to — finer than the
// 256 ms the 2048-sample buffer produced, not coarser.
//
// The PCM16 conversion happens HERE rather than on the main thread: posting already
// encoded bytes as a transferable is most of the point of moving at all.

/** 20 ms at 8 kHz. Kept in step with TALK_FRAME_SAMPLES in lib/talkWorklet.ts, and
 *  the test asserts the two agree. */
const FRAME_SAMPLES = 160;

/** Float32 samples ([-1,1]) → little-endian PCM16 bytes, the wire format the recorder
 *  reads. Full scale is asymmetric: the negative range is one step larger than the
 *  positive one, and scaling both by 0x7fff clips the loudest negative samples. */
function floatToPCM16LE(input) {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

class TalkCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frame = new Float32Array(FRAME_SAMPLES);
    this._used = 0;
    this._running = true;
    // The only message this accepts. Returning false from `process()` releases the
    // node for good, so this is one-way: a stopped processor is never restarted, it
    // is replaced on the next press.
    this.port.onmessage = (event) => {
      if (event.data === "stop") this._running = false;
    };
  }

  process(inputs) {
    if (!this._running) return false;
    const channel = inputs[0] && inputs[0][0];
    // No input this quantum — the mic has not started, or the source was
    // disconnected. Staying alive is the right answer: a `false` here would end the
    // capture permanently on a momentary gap.
    if (!channel || channel.length === 0) return true;

    let read = 0;
    while (read < channel.length) {
      const take = Math.min(FRAME_SAMPLES - this._used, channel.length - read);
      this._frame.set(channel.subarray(read, read + take), this._used);
      this._used += take;
      read += take;
      if (this._used === FRAME_SAMPLES) {
        const bytes = floatToPCM16LE(this._frame);
        // Transferred, not copied: the buffer leaves this thread outright.
        this.port.postMessage(bytes, [bytes.buffer]);
        this._used = 0;
      }
    }

    // `outputs` is deliberately untouched. The spec zero-fills it every quantum, so
    // writing nothing IS silence — and silence is not decoration here: the node is
    // connected through to the destination, and anything it emitted would come out of
    // the operator's own speakers and feed straight back into the microphone. The
    // muted gain node on the other side is the second half of that guard.
    return true;
  }
}

registerProcessor("talk-capture", TalkCaptureProcessor);
