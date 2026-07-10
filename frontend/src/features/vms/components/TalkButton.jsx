"use client";

// TalkButton (G6) — push-to-talk uplink for a `talk_capable` camera.
//
// Press-and-hold to talk INTO the camera's speaker; release to stop. The flow:
//   1. On press → POST /cameras/{id}/talk/session → a short-lived uplink session
//      { session_id, kind:"whip"|..., whip_url (carries ?token=), codec, token }.
//   2. getUserMedia({ audio:true }) → the browser microphone.
//   3. WHIP PUBLISH: a fresh RTCPeerConnection with the mic track (sendonly),
//      create offer → wait (bounded) for ICE → POST the SDP offer to `whip_url`
//      (Content-Type: application/sdp; Bearer token if present) → setRemoteDescription
//      with the answer. That's the standard WHIP handshake (RFC draft) MediaMTX
//      speaks for backchannel publish.
//   4. On release / blur / tab-hide / unmount → stop every mic track + close the
//      peer + null the session. The mic is NEVER left hot.
//
// Only kind "whip" is wired end-to-end here (that's what MediaMTX issues). Other
// kinds (rtsp_backchannel / http_push) are server-proxied — we surface a toast
// so the operator knows this camera needs a different path.
//
// This is # LIVE-VALIDATE: the handshake is built correctly but real audio into
// a camera speaker can only be confirmed on hardware with a backchannel-capable
// device. getUserMedia denial and 409 TALK_UNSUPPORTED are handled with a toast.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import vms from "../api";

const ICE_WAIT_MS = 3_000;

export default function TalkButton({ cameraId, disabled = false }) {
  const [talking, setTalking] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Live handles so teardown always finds them, even mid-connect.
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  // Guards against a release that lands before the async start resolves.
  const activeRef = useRef(false);

  // ── always-stop: mic off, peer closed, state cleared ──────────────────────
  const stop = useCallback(() => {
    activeRef.current = false;
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    setTalking(false);
    setConnecting(false);
  }, []);

  const start = useCallback(async () => {
    if (disabled || activeRef.current) return;
    activeRef.current = true;
    setConnecting(true);

    let session;
    try {
      session = await vms.cameras.talkSession(cameraId);
    } catch (e) {
      activeRef.current = false;
      setConnecting(false);
      const status = e?.response?.status;
      const code = e?.response?.data?.detail?.code || e?.response?.data?.code;
      if (status === 409 || code === "TALK_UNSUPPORTED") {
        toast.error("This camera does not support talk / two-way audio.");
      } else {
        toast.error(apiError(e, "Could not start talk session"));
      }
      return;
    }

    const kind = session?.kind;
    const whipUrl = session?.whip_url || session?.target_url;
    if (kind && kind !== "whip") {
      activeRef.current = false;
      setConnecting(false);
      toast.error(`Talk uplink kind "${kind}" is not supported in the browser.`);
      return;
    }
    if (!whipUrl) {
      activeRef.current = false;
      setConnecting(false);
      toast.error("Talk session did not return an uplink URL.");
      return;
    }

    // ── microphone ──────────────────────────────────────────────────────────
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      activeRef.current = false;
      setConnecting(false);
      if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
        toast.error("Microphone permission denied — allow mic access to talk.");
      } else if (e?.name === "NotFoundError") {
        toast.error("No microphone found on this device.");
      } else {
        toast.error("Could not access the microphone.");
      }
      return;
    }
    // A release may have fired while awaiting the mic — bail cleanly.
    if (!activeRef.current) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
      return;
    }
    streamRef.current = stream;

    // ── WHIP publish handshake ────────────────────────────────────────────────
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Mic is uplink-only; we don't want the camera's audio back on this peer
      // (listen is a separate concern on the video element).
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      // Some WHIP servers still expect a media line negotiated as sendonly.
      try {
        pc.getTransceivers().forEach((tr) => {
          if (tr.sender && tr.sender.track && tr.sender.track.kind === "audio") {
            tr.direction = "sendonly";
          }
        });
      } catch {}

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Bounded wait for ICE gathering so the offer carries candidates.
      await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const check = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", check);
        setTimeout(resolve, ICE_WAIT_MS);
      });
      if (!activeRef.current) return; // released mid-handshake

      const headers = { "Content-Type": "application/sdp" };
      // whip_url may already carry ?token=; if a bare token is issued too, send it
      // as a Bearer (MediaMTX accepts either).
      if (session?.token) headers.Authorization = `Bearer ${session.token}`;

      const res = await fetch(whipUrl, {
        method: "POST",
        headers,
        body: pc.localDescription.sdp,
      });
      if (!res.ok) throw new Error(`WHIP ${res.status}`);

      const answer = await res.text();
      if (!activeRef.current) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });

      if (!activeRef.current) return;
      setConnecting(false);
      setTalking(true);
    } catch (e) {
      // Any handshake failure → tear the mic down; never leave it hot.
      stop();
      toast.error(apiError(e, "Talk uplink failed (validate on real hardware)"));
    }
  }, [cameraId, disabled, stop]);

  // Safety net: release the mic on window blur / tab hide / unmount so a held
  // button that never got its pointer-up can't leave the mic streaming.
  useEffect(() => {
    const onBlur = () => stop();
    const onVis = () => document.hidden && stop();
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [stop]);

  const holdProps = {
    onPointerDown: (e) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      start();
    },
    onPointerUp: () => stop(),
    onPointerLeave: () => stop(),
    onPointerCancel: () => stop(),
  };

  const active = talking || connecting;

  return (
    <button
      type="button"
      title={disabled ? "Talk unavailable" : "Push and hold to talk"}
      disabled={disabled}
      {...holdProps}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold transition select-none ${
        talking
          ? "bg-red-600 text-white shadow-lg shadow-red-600/30"
          : connecting
            ? "bg-white/20 text-white"
            : "text-white/90 hover:bg-white/15 hover:text-white"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <Icon
        icon={talking ? "heroicons-solid:microphone" : "heroicons-outline:microphone"}
        className={`text-sm ${talking ? "animate-pulse" : ""}`}
      />
      {connecting ? "Connecting…" : talking ? "Talking…" : "Talk"}
    </button>
  );
}
