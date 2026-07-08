// Form ↔ API mappers for the camera onboard/edit modal. The modal keeps a FLAT
// form object (constants.DEFAULT_CAMERA_FORM) for simple field binding; these
// translate to/from the nested CameraCreate / CameraUpdate / CameraPublic shapes.

import { DEFAULT_CAMERA_FORM } from "./constants";

const num = (v) => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

// Flat form → CameraCreate body (nested). Drops empty optional fields.
export function toCreateBody(form) {
  const body = {
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
      fps: num(form.recording_fps),
      record_substream: !!form.record_substream,
      retention_days: num(form.retention_days) ?? 30,
      pre_buffer_seconds: num(form.pre_buffer_seconds) ?? 5,
      post_buffer_seconds: num(form.post_buffer_seconds) ?? 5,
      anr_enabled: !!form.anr_enabled,
    },
    ptz: { capable: !!form.ptz_capable },
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
export function toUpdateBody(form) {
  const body = toCreateBody(form);
  if (body.onvif && !form.onvif_password) delete body.onvif.password;
  return body;
}

// CameraPublic → flat form (for the edit modal).
export function fromCamera(cam) {
  const net = cam.network_info || {};
  const rec = cam.recording || {};
  const onvif = cam.onvif || {};
  const place = cam.placement || {};
  return {
    ...DEFAULT_CAMERA_FORM,
    name: cam.name || "",
    brand: cam.brand || "onvif",
    connection_type: cam.connection_type || "onvif",
    is_enabled: cam.is_enabled ?? true,
    ip: net.ip || "",
    port: net.port ?? 80,
    rtsp_port: net.rtsp_port ?? 554,
    onvif_host: onvif.host || "",
    onvif_port: onvif.port ?? 80,
    onvif_user: onvif.user || "",
    onvif_password: "",
    has_password: !!onvif.has_password,
    onvif_profile_token: onvif.profile_token || "",
    recording_mode: rec.mode || "continuous",
    recording_fps: rec.fps ?? "",
    record_substream: !!rec.record_substream,
    retention_days: rec.retention_days ?? 30,
    pre_buffer_seconds: rec.pre_buffer_seconds ?? 5,
    post_buffer_seconds: rec.post_buffer_seconds ?? 5,
    anr_enabled: !!rec.anr_enabled,
    ptz_capable: !!(cam.ptz && cam.ptz.capable),
    site_id: place.site_id || "",
    floor_id: place.floor_id || "",
    zone_id: place.zone_id || "",
  };
}

// Basic client-side validation → { field: message }.
export function validateCamera(form) {
  const errors = {};
  if (!form.name?.trim() || form.name.trim().length < 2) errors.name = "Required (min 2 chars)";
  if (form.connection_type === "rtsp" && !form.ip?.trim()) errors.ip = "IP required for direct RTSP";
  return errors;
}
