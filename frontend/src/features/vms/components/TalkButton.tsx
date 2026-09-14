"use client";

// TalkButton (G6) — push-to-talk into a camera's speaker, carried by the RECORDER.
//
// Press-and-hold to talk; release to stop. The flow:
//   1. On press → POST …/talk → the recorder's capability + transport check, and the
//      audited record that somebody spoke. It answers honestly when the camera cannot
//      receive talk-back, or when the recorder cannot carry the microphone to it.
//   2. getUserMedia({ audio:true }) into an 8 kHz AudioContext — the browser resamples
//      the mic (usually 48 kHz) to G.711's rate natively, so there is no hand-rolled
//      resampler here to get wrong. Capture runs in an AudioWorklet, on the audio
//      thread; see lib/talkWorklet.ts and public/audio/talk-capture-worklet.js.
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
import { TALK_SAMPLE_RATE, canCaptureTalk, createTalkCaptureNode } from "../lib/talkWorklet";

/** The live capture pipeline for one press, held in a ref so start and stop share it
 *  without re-rendering. */
interface AudioGraph {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  /** Capture, on the audio thread. Posts encoded PCM16LE frames over its port. */
  node: AudioWorkletNode;
  /** Gain pinned to 0, between the capture node and the destination. See `start`. */
  mute: GainNode;
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

/** The mic glyph. CONNECTING is its own state and outranks talking: the uplink
 *  is not open yet, and a solid microphone there says the room can hear the
 *  operator before it can. */
function micIcon(connecting: boolean, talking: boolean): string {
  if (connecting) return "svg-spinners:180-ring";
  return talking ? "heroicons-solid:microphone" : "heroicons-outline:microphone";
}

export default function TalkButton({ nodeId, cameraId, disabled = false }: Readonly<TalkButtonProps>) {
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
        // Tell the processor to retire (its `process` returns false), then stop
        // listening: a frame posted between these two lines must not be enqueued
        // into a body that is about to close.
        g.node.port.onmessage = null;
        g.node.port.postMessage("stop");
        g.node.disconnect();
        g.mute.disconnect();
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

    // A browser without AudioWorklet must REFUSE rather than open a mic that feeds
    // nothing: an operator who believes the room heard them is the dangerous failure
    // here. Checked before the recorder is asked, so such a browser never books a
    // talk session or writes the audit record for a talkspurt that never happened.
    if (!canCaptureTalk()) {
      toast.error("This browser cannot capture audio for talk-back — use a supported browser.");
      return;
    }

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

      // Loading the worklet is a fetch, so it can fail on a bad deploy or an offline
      // appliance — and it is awaited, so a release can land during it.
      let node: AudioWorkletNode;
      try {
        node = await createTalkCaptureNode(ctx);
      } catch {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        activeRef.current = false;
        setConnecting(false);
        toast.error("Talk-back audio could not start on this device.");
        return;
      }
      if (!activeRef.current) {
        node.port.postMessage("stop");
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        return;
      }

      const source = ctx.createMediaStreamSource(stream);

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
      // THE ANTI-FEEDBACK GUARD, re-established for the worklet.
      //
      // The ScriptProcessor version zero-filled its output buffer every callback,
      // because a node connected to the destination plays whatever it emits — in a
      // control room that is the operator's own microphone coming back out of their
      // speakers and into the mic again. A worklet does not carry that trick across:
      // it has no output buffer handed to a main-thread callback.
      //
      // So the guard is two independent things, either of which alone is silence:
      // the processor never writes to `outputs` (the spec zero-fills them each
      // quantum), and everything it could emit passes through this gain pinned at 0.
      // Two, because the connection to the destination is not decoration — it is what
      // guarantees the graph is PULLED, and a capture node that is never pulled is
      // the silent failure this whole path is written to avoid.
      const mute = ctx.createGain();
      mute.gain.value = 0;

      const graph: AudioGraph = { ctx, stream, source, node, mute, bodyController: null, abort };

      node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        try {
          bodyController?.enqueue(new Uint8Array(ev.data));
        } catch {
          // The stream was cancelled (released mid-frame).
        }
      };

      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
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
      <Icon icon={micIcon(connecting, talking)} className="text-sm" />
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
