"use client";

// TalkButton (G6) — push-to-talk into a camera's speaker, carried by the RECORDER.
//
// Press-and-hold to talk; release to stop. The flow:
//   1. On press → POST …/talk → the recorder's capability + transport check, and the
//      audited record that somebody spoke. It answers honestly when the camera cannot
//      receive talk-back, or when the recorder cannot carry the microphone to it.
//   2. getUserMedia({ audio:true }) into an 8 kHz AudioContext — the browser resamples
//      the mic (usually 48 kHz) to G.711's rate natively, so there is no hand-rolled
//      resampler here to get wrong.
//   3. Stream the raw little-endian PCM16 samples as the BODY of one long-lived POST
//      to …/talk/uplink, held open for the whole press. The recorder reads frames off
//      it, compands to the camera's G.711 and pushes RTP over the ONVIF/RTSP
//      backchannel. Closing the body ends the talkspurt and tears the backchannel down.
//   4. On release / blur / tab-hide / unmount → stop every mic track, close the body,
//      abort the request. The mic is NEVER left hot.
//
// It used to do a WHIP publish to MediaMTX against a VMS-issued talk session. That
// path is gone with the VMS's own audio plane: the recorder holds the camera
// credentials and the backchannel, so it is the only thing that can deliver audio to
// the speaker — and it speaks PCM16 over a streamed body, not WHIP.
//
// WHAT IS NOT PROVEN: that a specific camera accepts the handshake and plays the
// audio. The recorder gates the whole uplink behind VE_TALK_TRANSPORT, off by
// default, and answers 501 when it is not set. That refusal is surfaced as a toast
// rather than a button that looks live and sends into nothing.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { api, apiError, tokens } from "@/lib/api";
import vms from "../api";

// 8 kHz mono is G.711's rate; capturing straight into an 8 kHz AudioContext lets the
// browser resample for us.
const TALK_SAMPLE_RATE = 8000;
// 20 ms frames (160 samples) match the recorder's packetizer ptime; this buffer is
// the nearest power of two and only governs flush granularity — the recorder re-frames
// to exactly 20 ms regardless.
const PROCESSOR_BUFFER = 2048;

/** The live capture pipeline for one press, held in a ref so start and stop share it
 *  without re-rendering. */
interface AudioGraph {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  /** Pushes one PCM16LE chunk into the request body; closing it ends the press. */
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
  abort: AbortController;
}

export interface TalkButtonProps {
  /** The recorder that holds this camera's credentials and backchannel. */
  nodeId: string;
  /** The camera's id ON that recorder. */
  cameraId: string;
  disabled?: boolean;
}

export default function TalkButton({ nodeId, cameraId, disabled = false }: TalkButtonProps) {
  const [talking, setTalking] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const graphRef = useRef<AudioGraph | null>(null);
  // Guards a release that lands before the async start resolves.
  const activeRef = useRef(false);

  // ── always-stop: mic off, body closed, request aborted ────────────────────
  const stop = useCallback(() => {
    activeRef.current = false;
    const g = graphRef.current;
    graphRef.current = null;
    if (g) {
      try {
        g.processor.onaudioprocess = null;
        g.processor.disconnect();
        g.source.disconnect();
      } catch {
        /* graph already torn down */
      }
      // End the body so the recorder sees EOF and tears the backchannel down. This
      // is the ORDERLY end of a talkspurt; the abort below is only a backstop for a
      // request still connecting.
      try {
        g.bodyController?.close();
      } catch {
        /* already closed */
      }
      try {
        g.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* tracks already stopped */
      }
      void g.ctx.close().catch(() => {});
      g.abort.abort();
    }
    setTalking(false);
    setConnecting(false);
  }, []);

  const start = useCallback(async () => {
    if (disabled || activeRef.current) return;
    activeRef.current = true;
    setConnecting(true);

    // 1. Ask the recorder first. A camera that cannot receive talk-back, or a
    //    recorder that cannot carry the mic to it, is a refusal with a sentence —
    //    and it is better to hear it before the microphone is opened.
    try {
      await vms.federation.talk.begin(nodeId, cameraId);
    } catch (e) {
      activeRef.current = false;
      setConnecting(false);
      toast.error(apiError(e, "This camera cannot receive talk-back"));
      return;
    }
    if (!activeRef.current) return; // released while asking

    try {
      const ctx = new AudioContext({ sampleRate: TALK_SAMPLE_RATE });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      // A release may have fired while awaiting the mic — bail cleanly rather than
      // leaving a hot microphone behind.
      if (!activeRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        return;
      }

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);

      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          bodyController = null;
        },
      });

      const abort = new AbortController();
      const graph: AudioGraph = { ctx, stream, source, processor, bodyController: null, abort };

      processor.onaudioprocess = (ev: AudioProcessingEvent) => {
        try {
          bodyController?.enqueue(floatToPCM16LE(ev.inputBuffer.getChannelData(0)));
        } catch {
          // The stream was cancelled (released mid-callback).
        }
        // Silence the output leg, or the mic echoes back out of the operator's own
        // speakers — which in a control room is a feedback loop.
        ev.outputBuffer.getChannelData(0).fill(0);
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      graph.bodyController = bodyController;
      graphRef.current = graph;
      setConnecting(false);
      setTalking(true);

      // 2. One long-lived streamed POST. `fetch`, not the axios instance: axios
      //    buffers a request body, which would hold every frame until the operator
      //    let go — the difference between speaking to somebody and playing them a
      //    recording of it afterwards. The Bearer header is attached by hand for the
      //    same reason (this bypasses the axios interceptor that normally adds it).
      const res = await fetch(uplinkUrl(nodeId, cameraId), {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}),
        },
        body,
        signal: abort.signal,
        credentials: "include",
        // Streaming uploads require half-duplex; the DOM types lag the runtime.
        // @ts-expect-error duplex is valid at runtime.
        duplex: "half",
      });
      if (!res.ok && res.status !== 0) {
        let detail = `Talk uplink refused (${res.status})`;
        try {
          const body = (await res.json()) as { error?: { message?: string }; detail?: string };
          detail = body?.error?.message || body?.detail || detail;
        } catch {
          /* non-JSON body */
        }
        toast.error(detail);
        stop();
      }
    } catch (e) {
      // An AbortError is the normal stop() during connect, not a failure to report.
      if (e instanceof DOMException && e.name === "AbortError") return;
      const name = e instanceof Error ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        toast.error("Microphone permission denied — allow mic access to talk.");
      } else if (name === "NotFoundError") {
        toast.error("No microphone found on this device.");
      } else {
        toast.error(apiError(e, "Could not start talking"));
      }
      stop();
    }
  }, [disabled, nodeId, cameraId, stop]);

  // Never leave a mic open: a release that never arrives (alt-tab mid-press), a
  // camera change, or an unmount all tear the graph down.
  useEffect(() => {
    const end = () => stop();
    const onVis = () => document.hidden && stop();
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [stop]);
  useEffect(() => stop, [nodeId, cameraId, stop]);

  const hold = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      void start();
    },
    onPointerUp: () => stop(),
    onPointerLeave: () => stop(),
    onPointerCancel: () => stop(),
  };

  return (
    <button
      type="button"
      {...hold}
      disabled={disabled}
      title={talking ? "Release to stop talking" : "Hold to talk"}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition disabled:opacity-40 ${
        talking
          ? "bg-red-500/80 text-white"
          : "bg-white/10 text-white/85 hover:bg-white/20"
      }`}
    >
      <Icon
        icon={connecting ? "svg-spinners:180-ring" : talking ? "heroicons-solid:microphone" : "heroicons-outline:microphone"}
        className="text-sm"
      />
      {talking ? "Talking" : "Talk"}
    </button>
  );
}

/** The uplink endpoint as an absolute path on the same origin the api client uses.
 *
 *  Built here rather than in api.ts because this is the ONE call that cannot go
 *  through axios — it needs a streamed request body — so it also cannot inherit the
 *  axios baseURL. */
function uplinkUrl(nodeId: string, cameraId: string): string {
  const base = api.defaults.baseURL || "/api/v1";
  return `${base}/vms/federation/nodes/${encodeURIComponent(nodeId)}/cameras/${encodeURIComponent(cameraId)}/talk/uplink`;
}

/** Float32 samples ([-1,1]) → little-endian PCM16 bytes, the wire format the
 *  recorder reads. Full scale is asymmetric: the negative range is one step larger
 *  than the positive one, and scaling both by 0x7fff clips the loudest negative
 *  samples. */
function floatToPCM16LE(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
