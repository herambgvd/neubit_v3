// Form ↔ API mappers for the camera onboard/edit modal. The modal keeps a FLAT
// form object (constants.DEFAULT_CAMERA_FORM) for simple field binding; these
// translate to/from the nested CameraCreate / CameraUpdate / CameraPublic shapes.

import type { CameraPublic } from "@/lib/types";
import { DEFAULT_CAMERA_FORM } from "./constants";
import type {
  CameraCreate,
  CameraForm,
  CameraFormErrors,
  ConnectionType,
  EstateCamera,
  OnvifConfig,
  RecordingConfigBody,
  RecordingMode,
  VmsCameraPublic,
} from "./types";

const num = (v: number | string | null | undefined): number | undefined => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

// True when a camera advertises PTZ. Handles both the nested CameraPublic shape
// ({ ptz: { capable } }) and the flat edit-form shape ({ ptz_capable }).
export function isPtzCapable(
  cam: Pick<EstateCamera, "ptz" | "ptz_capable"> | Pick<CameraForm, "ptz_capable"> | null | undefined,
): boolean {
  if (!cam) return false;
  return !!(cam.ptz_capable || ("ptz" in cam && cam.ptz && cam.ptz.capable));
}

/** `CameraCreate` with the ONVIF block spelled out — `toUpdateBody` strips the
 *  password off it when the operator left the field blank. */
export type CameraFormBody = CameraCreate & { onvif?: OnvifConfig };

// Flat form → CameraCreate body (nested). Drops empty optional fields.
export function toCreateBody(form: CameraForm): CameraFormBody {
  const body: CameraFormBody = {
    name: form.name?.trim(),
    brand: form.brand,
    connection_type: form.connection_type,
    is_enabled: !!form.is_enabled,
    network_info: {
      ip: form.ip || undefined,
      port: num(form.port),
      rtsp_port: num(form.rtsp_port),
    },
    recording: {
      mode: form.recording_mode,
      schedule: form.recording_schedule || undefined,
      fps: num(form.recording_fps),
      record_substream: !!form.record_substream,
      retention_days: num(form.retention_days) ?? 30,
      pre_buffer_seconds: num(form.pre_buffer_seconds) ?? 5,
      post_buffer_seconds: num(form.post_buffer_seconds) ?? 5,
      anr_enabled: !!form.anr_enabled,
      // G6 — include the audio track in the recording (MediaMTX/ffmpeg carries
      // it when the source stream has audio).
      audio_enabled: !!form.audio_enabled,
    },
    ptz: { capable: !!form.ptz_capable },
    // Per-camera storage pool — "" clears to the default recordings volume.
    storage_pool_id: form.storage_pool_id || undefined,
    // Recorder (media node) the camera is pinned to — "" / null = Auto (default node).
    media_node_id: form.media_node_id || null,
    placement: {
      site_id: form.site_id || undefined,
      floor_id: form.floor_id || undefined,
      zone_id: form.zone_id || undefined,
    },
  };

  // Only attach ONVIF when there's something to send.
  if (form.onvif_host || form.onvif_user || form.onvif_password || form.onvif_profile_token) {
    body.onvif = {
      host: form.onvif_host || form.ip || undefined,
      port: num(form.onvif_port),
      user: form.onvif_user || undefined,
      password: form.onvif_password || undefined,
      profile_token: form.onvif_profile_token || undefined,
    };
  }
  return body;
}

// Flat form → CameraUpdate body. Same shape; the password is only sent when the
// operator typed a new one (blank = keep stored).
export function toUpdateBody(form: CameraForm): CameraFormBody {
  const body = toCreateBody(form);
  if (body.onvif && !form.onvif_password) delete body.onvif.password;
  return body;
}

// CameraPublic → flat form (for the edit modal).
export function fromCamera(cam: VmsCameraPublic | CameraPublic): CameraForm {
  // lib/types' CameraPublic keeps the config blocks opaque; read them through the
  // feature's narrowed shape (an empty block for a field the row does not carry).
  const c = cam as VmsCameraPublic;
  const net = c.network_info || {};
  const rec = c.recording || {};
  const onvif = c.onvif || {};
  const place = c.placement || {};
  return {
    ...DEFAULT_CAMERA_FORM,
    name: c.name || "",
    brand: c.brand || "onvif",
    connection_type: (c.connection_type as ConnectionType) || "onvif",
    is_enabled: c.is_enabled ?? true,
    ip: net.ip || "",
    port: net.port ?? 80,
    rtsp_port: net.rtsp_port ?? 554,
    onvif_host: onvif.host || "",
    onvif_port: onvif.port ?? 80,
    onvif_user: onvif.user || "",
    onvif_password: "",
    has_password: !!onvif.has_password,
    onvif_profile_token: onvif.profile_token || "",
    recording_mode: (rec.mode as RecordingMode) || "continuous",
    recording_schedule: rec.schedule || null,
    recording_fps: rec.fps ?? "",
    record_substream: !!rec.record_substream,
    retention_days: rec.retention_days ?? 30,
    pre_buffer_seconds: rec.pre_buffer_seconds ?? 5,
    post_buffer_seconds: rec.post_buffer_seconds ?? 5,
    anr_enabled: !!rec.anr_enabled,
    audio_enabled: !!rec.audio_enabled,
    storage_pool_id: c.storage_pool_id || "",
    media_node_id: c.media_node_id || "",
    ptz_capable: !!(c.ptz && c.ptz.capable),
    site_id: place.site_id || "",
    floor_id: place.floor_id || "",
    zone_id: place.zone_id || "",
  };
}

// Flat form → the dedicated `PUT /cameras/{id}/recording` body
// (RecordingConfigBody: mode / schedule / retention_days / record_substream —
// the router's body is `extra="forbid"`, so the keys must match exactly).
export function toRecordingConfigBody(form: CameraForm): RecordingConfigBody {
  return {
    mode: form.recording_mode,
    schedule: form.recording_mode === "schedule" ? form.recording_schedule || {} : {},
    retention_days: num(form.retention_days) ?? 30,
    record_substream: !!form.record_substream,
  };
}

// Basic client-side validation → { field: message }.
export function validateCamera(form: CameraForm): CameraFormErrors {
  const errors: CameraFormErrors = {};
  if (!form.name?.trim() || form.name.trim().length < 2) errors.name = "Required (min 2 chars)";
  if (form.connection_type === "rtsp" && !form.ip?.trim()) errors.ip = "IP required for direct RTSP";
  return errors;
}
