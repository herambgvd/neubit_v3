"use client";

// Simulator tab — fire a synthetic event through trigger + alert-format matching
// without needing a real device.
//
// Ported from neubit_v2's rich simulator: a camera picker, an access-control
// device picker, and a set of device-shaped scenario presets (Health / Lumina /
// Access) that build realistic `cap`/`raw` payloads mirroring the actual neubit
// device events — so trigger conditions written against those paths match here
// exactly as they would in production. Selecting a preset fills the composer
// (event_type + JSON payload); you can still hand-edit before sending.
//
// The composer submits through v3's simulate contract:
//   POST /workflow/events/simulate { event_type, payload, site_id, alert_code, dry_run }
//   → { matched_triggers, matched_format, skipped, created_instance_id(s), dry_run }
// so the result panel reflects v3's matcher (not v2's rules/instances_created shape).
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Spinner, Badge } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, idOf } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { vmsInventory, accessInventory } from "@/lib/api/deviceInventory";
import { workflow as wfApi } from "../../api";

/* ── Device field normalizers ──────────────────────────────────────────────
 * v3 camera/access objects use different field names than v2 (id vs camera_id,
 * placement.site_id vs site_id, network_info.ip vs .ip_address, brand vs
 * manufacturer). We normalize the INPUT here; the EMITTED payloads below keep
 * v2's canonical device-event field names (camera_id, ip_address, …) unchanged
 * so existing trigger configs keep matching.
 */
function camFields(cam) {
  if (!cam) return null;
  const ni = cam.network_info || {};
  return {
    id: idOf(cam, "id", "camera_id") || "",
    name: cam.name || "",
    site_id: cam.placement?.site_id || cam.site_id || "",
    ip: ni.ip || ni.ip_address || "",
    port: ni.port || 80,
    mac: ni.mac || cam.mac_address || "",
    brand: cam.brand || cam.manufacturer || "",
    model: cam.driver || cam.model || "",
    channel: cam.nvr_channel_number != null ? `CH${cam.nvr_channel_number}` : "CH1",
    lastSeen: cam.last_seen_at || "",
  };
}

function acFields(ac) {
  if (!ac) return null;
  const base = ac.base_url || "";
  return {
    id: idOf(ac, "id", "instance_id") || "",
    name: ac.name || "GVD Controller",
    site_id: ac.site_id || "",
    baseUrl: base,
    ip: base.replace(/^https?:\/\//, "").split("/")[0] || "192.168.1.150",
  };
}

const iso = () => new Date().toISOString();
const unix = () => Math.floor(Date.now() / 1000);

/* ── Scenario presets ──────────────────────────────────────────────────────
 * Each preset builds a payload from the selected (normalized) camera / site /
 * access controller. `requiresCamera:false` presets (access) don't need a camera.
 */
const PRESETS = [
  // ── Custom (device-independent) ───────────────────────────────────────────
  {
    id: "motion_custom",
    label: "Motion (custom)",
    icon: "heroicons-outline:eye",
    category: "custom",
    requiresCamera: false,
    buildPayload: () => ({
      event_type: "motion",
      source: "custom",
      severity: "medium",
      description: "Simulated motion event",
      zone: "perimeter",
    }),
  },
  {
    id: "ingest_custom",
    label: "Ingest event",
    icon: "heroicons-outline:inbox-arrow-down",
    category: "custom",
    requiresCamera: false,
    buildPayload: () => ({
      event_type: "ingest.event",
      source_service: "ingest",
      severity: "high",
      data: { key: "value" },
    }),
  },

  // ── Health ────────────────────────────────────────────────────────────────
  {
    id: "camera_offline",
    label: "Camera Offline",
    icon: "heroicons-outline:signal-slash",
    category: "health",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "offline",
      alarm_type: "offline",
      source_service: "vms",
      device_type: "camera",
      device_id: cam?.id || "",
      device_name: cam?.name || "",
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      site_id: cam?.site_id || "",
      severity: "high",
      ip_address: cam?.ip || "",
      cap: {
        event_info: {
          id: `SIM-OFFLINE-${Date.now()}`,
          type: "offline",
          from: "camera",
          time: iso(),
          description: `camera '${cam?.name || ""}' went offline`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: cam?.id || "",
          severity: "high",
          status_from: "online",
          status_to: "offline",
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [],
        additional_info: {
          device_type: "camera",
          manufacturer: cam?.brand || "",
          model: cam?.model || "",
          last_seen: cam?.lastSeen || "",
          ping_status: "failure",
          ping_response_ms: "5001",
          rtsp_status: "timeout",
          rtsp_response_ms: "5000",
          error_message: "Connection timed out after 5.0s (simulated)",
        },
      },
    }),
  },

  // ── Lumina analytics ───────────────────────────────────────────────────────
  {
    id: "lumina_motion",
    label: "Motion Detection",
    icon: "heroicons-outline:eye",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "motion",
      alarm_type: "motion",
      source_service: "vms",
      alert_id: `SIM-MOTION-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      cap: {
        event_info: {
          id: `SIM-MOTION-${Date.now()}`,
          type: "motion",
          from: "camera",
          time: iso(),
          description: `Motion Detection detected on ${cam?.name || ""}`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: `${cam?.name || ""}-${cam?.id || ""}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [],
        additional_info: { source: "simulator" },
      },
    }),
  },
  {
    id: "lumina_lp",
    label: "License Plate",
    icon: "heroicons-outline:truck",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "lp",
      alarm_type: "lp",
      source_service: "vms",
      alert_id: `SIM-LP-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      raw: {
        data: {
          dev_net_info: [
            {
              device_name: cam?.name || "GV-DNC273-P-AI",
              mac: cam?.mac || "8C-1F-64-D5-DA-99",
              ip: cam?.ip || "192.168.1.162",
              phy: "eth0",
              ChannelName: cam?.channel || "CH1",
            },
          ],
          ai_snap_picture: {
            PlateInfo: [
              {
                Id: "", GrpId: 3, SnapId: "RJ14CV0002", Type: 10, StrChn: "CH1",
                StartTime: unix(), EndTime: unix() + 4, BgImgWidth: 640, BgImgHeight: 352,
                Chn: 0, Sex: 0, PlateColor: 0, CarBrand: "", CarType: "", Owner: "",
                IdCode: "", Job: "", Phone: "", Domicile: "", Remark: "",
                ImageAllInfo: "", PlateImg: "", BgImg: "",
              },
            ],
          },
          subscribe_id: 1,
          data_pos: 2959,
        },
      },
      cap: {
        event_info: {
          id: `SIM-LP-${Date.now()}`,
          type: "lp",
          from: "camera",
          time: iso(),
          description: `License Plate Recognition detected on ${cam?.name || ""} - RJ14CV0002`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: `${cam?.name || ""}/${cam?.channel || "CH1"}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [{ id: "RJ14CV0002", captured_at: iso(), mime_type: "image/jpeg", encoding: "base64", data: "" }],
        additional_info: {
          source: "simulator",
          license_plate: {
            plate_number: "RJ14CV0002", plate_color: 0, vehicle_type: "", vehicle_brand: "",
            owner: "", channel: "CH1", start_time: unix(), end_time: unix() + 4,
          },
        },
      },
    }),
  },
  {
    id: "lumina_fd",
    label: "Face Detection",
    icon: "heroicons-outline:user-circle",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "fd",
      alarm_type: "fd",
      source_service: "gvd",
      alert_id: `SIM-FD-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      raw: {
        data: {
          dev_net_info: [
            {
              device_name: cam?.name || "GV-DNC275-AI",
              mac: cam?.mac || "8C-1F-64-D5-DA-99",
              ip: cam?.ip || "192.168.1.211",
              phy: "eth0",
              ChannelName: cam?.name || "GVD TEST",
            },
          ],
          ai_snap_picture: {
            FaceInfo: [
              {
                Id: 0, GrpId: 101777808693727380, Name: "Unknown Face", MD5: "", SnapId: 42,
                Type: 0, Score: 80, StartTime: unix(), EndTime: unix() + 6, BgImgWidth: 640,
                BgImgHeight: 352, Similarity: 0.0, Chn: 0, Sex: 0, Age: 25, StrChn: "CH1",
                Gender: 0, fAttrAge: 25, Expression: 0, GlassesType: -1, MouthMask: 0, Race: 0,
                ImageAllInfo: "", Image2: "", Image4: "", Feature: "", FtVersion: 8388612,
              },
            ],
          },
          subscribe_id: 1,
          data_pos: 9503,
        },
      },
      cap: {
        event_info: {
          id: `SIM-FD-${Date.now()}`,
          type: "fd",
          from: "camera",
          time: iso(),
          description: `Face Detection detected on ${cam?.name || ""}`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: cam?.mac || `${cam?.name || ""}-${cam?.id || ""}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [{ id: 42, captured_at: iso(), mime_type: "image/jpeg", encoding: "base64", data: "" }],
        additional_info: {
          source: "simulator", channel: "CH1", face_id: 0, face_score: 80, age: 25,
          gender: 0, expression: 0, device_mac: cam?.mac || "8C-1F-64-D5-DA-99",
        },
      },
    }),
  },
  {
    id: "lumina_lc",
    label: "Line Crossing",
    icon: "heroicons-outline:bolt",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "lcd",
      alarm_type: "lcd",
      source_service: "gvd",
      alert_id: `SIM-LCD-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      raw: {
        data: {
          dev_net_info: [
            {
              device_name: cam?.name || "GV-DNC275-AI",
              mac: cam?.mac || "8C-1F-64-D5-DA-99",
              ip: cam?.ip || "192.168.1.211",
              phy: "eth0",
              ChannelName: cam?.name || "GVD TEST",
            },
          ],
          alarm_list: [
            {
              time: iso(),
              channel_alarm: [
                {
                  int_alarm: { alarm_val: true, int_subtype: "lcd" },
                  int_alarm_ex: [{ alarm_val: true, int_subtype: "lcd", take_alarm_snap: 707 }],
                  channel: "CH1",
                  record_flag: { s: "G" },
                },
              ],
            },
          ],
          alarm_snap_data: [
            { channel: "CH1", img_id: 707, img_time: unix(), img_encode: "base64", img_format: "image/jpeg", img_data: "" },
          ],
          subscribe_id: 1,
          data_pos: 6957,
        },
      },
      cap: {
        event_info: {
          id: `SIM-LCD-${Date.now()}`,
          type: "lcd",
          from: "camera",
          time: iso(),
          description: `Line Crossing detected on ${cam?.name || ""}`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: cam?.mac || `${cam?.name || ""}-${cam?.id || ""}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [{ id: 707, captured_at: iso(), mime_type: "image/jpeg", encoding: "base64", data: "" }],
        additional_info: {
          source: "simulator", channel: "CH1", device_mac: cam?.mac || "8C-1F-64-D5-DA-99",
          alarm_active: true, take_alarm_snap: 707,
        },
      },
    }),
  },
  {
    id: "lumina_pid",
    label: "Perimeter Intrusion",
    icon: "heroicons-outline:viewfinder-circle",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "pid",
      alarm_type: "pid",
      source_service: "gvd",
      alert_id: `SIM-PID-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      raw: {
        data: {
          dev_net_info: [
            {
              device_name: cam?.name || "GV-DNC275-AI",
              mac: cam?.mac || "8C-1F-64-D5-DA-99",
              ip: cam?.ip || "192.168.1.211",
              phy: "eth0",
              ChannelName: cam?.name || "GVD TEST",
            },
          ],
          alarm_list: [
            {
              time: iso(),
              channel_alarm: [
                {
                  int_alarm: { alarm_val: true, int_subtype: "pid" },
                  int_alarm_ex: [{ alarm_val: true, int_subtype: "pid", take_alarm_snap: 620 }],
                  channel: "CH1",
                  record_flag: { s: "G" },
                },
              ],
            },
          ],
          alarm_snap_data: [
            { channel: "CH1", img_id: 620, img_time: unix(), img_encode: "base64", img_format: "image/jpeg", img_data: "" },
          ],
          subscribe_id: 1,
          data_pos: 2077,
        },
      },
      cap: {
        event_info: {
          id: `SIM-PID-${Date.now()}`,
          type: "pid",
          from: "camera",
          time: iso(),
          description: `Perimeter Intrusion detected on ${cam?.name || ""}`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: cam?.mac || `${cam?.name || ""}-${cam?.id || ""}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [{ id: 620, captured_at: iso(), mime_type: "image/jpeg", encoding: "base64", data: "" }],
        additional_info: {
          source: "simulator", channel: "CH1", device_mac: cam?.mac || "8C-1F-64-D5-DA-99",
          alarm_active: true, alarm_subtype: "pid", take_alarm_snap: 620,
        },
      },
    }),
  },
  {
    id: "lumina_pvd",
    label: "Pedestrian & Vehicle",
    icon: "heroicons-outline:camera",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "pvd",
      alarm_type: "pvd",
      source_service: "gvd",
      alert_id: `SIM-PVD-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      raw: {
        data: {
          dev_net_info: [
            {
              device_name: cam?.name || "GV-DNC275-AI",
              mac: cam?.mac || "8C-1F-64-D5-DA-99",
              ip: cam?.ip || "192.168.1.211",
              phy: "eth0",
              ChannelName: cam?.name || "GVD TEST",
            },
          ],
          ai_snap_picture: {
            SnapedObjInfo: [
              {
                Chn: 0, StrChn: "CH1", StartTime: unix(), EndTime: unix() + 2, SnapId: 12,
                Type: 1, BgImgWidth: 640, BgImgHeight: 352, ImageAllInfo: "", ObjectImage: "", Background: "",
              },
            ],
          },
          subscribe_id: 1,
          data_pos: 3688,
        },
      },
      cap: {
        event_info: {
          id: `SIM-PVD-${Date.now()}`,
          type: "pvd",
          from: "camera",
          time: iso(),
          description: `Pedestrian & Vehicle Detection detected on ${cam?.name || ""}`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: cam?.mac || `${cam?.name || ""}-${cam?.id || ""}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [{ id: 12, captured_at: iso(), mime_type: "image/jpeg", encoding: "base64", data: "" }],
        additional_info: {
          source: "simulator", channel: "CH1", object_type_code: 1,
          start_time: unix(), end_time: unix() + 2, device_mac: cam?.mac || "8C-1F-64-D5-DA-99",
        },
      },
    }),
  },
  {
    id: "lumina_cd",
    label: "Crowd Density",
    icon: "heroicons-outline:users",
    category: "lumina",
    requiresCamera: true,
    buildPayload: (cam, site) => ({
      event_type: "cd",
      alarm_type: "cd",
      source_service: "gvd",
      alert_id: `SIM-CD-${Date.now()}`,
      timestamp: iso(),
      camera_id: cam?.id || "",
      camera_name: cam?.name || "",
      device_name: cam?.name || "",
      site_id: cam?.site_id || "",
      ip_address: cam?.ip || "",
      raw: {
        data: {
          dev_net_info: [
            {
              device_name: cam?.name || "GV-DNC273-P-AI",
              mac: cam?.mac || "8C-1F-64-CC-65-BF",
              ip: cam?.ip || "192.168.1.212",
              phy: "eth0",
              ChannelName: cam?.channel || "test",
            },
          ],
          alarm_list: [
            {
              time: iso(),
              channel_alarm: [
                {
                  int_alarm: { alarm_val: true, int_subtype: "cd" },
                  int_alarm_ex: [{ alarm_val: true, int_subtype: "cd", take_alarm_snap: 732 }],
                  channel: "CH1",
                  record_flag: { s: "G" },
                },
              ],
            },
          ],
          alarm_snap_data: [
            { channel: "CH1", img_id: 732, img_time: unix(), img_encode: "base64", img_format: "image/jpeg", img_data: "" },
          ],
          subscribe_id: 1,
          data_pos: 1240,
        },
      },
      cap: {
        event_info: {
          id: `SIM-CD-${Date.now()}`,
          type: "cd",
          from: "camera",
          time: iso(),
          description: `Crowd Density detected on ${cam?.name || ""}`,
          ip: cam?.ip || "",
          port: String(cam?.port || "80"),
          device_id: cam?.mac || `${cam?.name || ""}-${cam?.id || ""}`,
        },
        location_info: { id: cam?.site_id || "", name: site?.name || "", latitude: "", longitude: "" },
        images: [{ id: 732, captured_at: iso(), mime_type: "image/jpeg", encoding: "base64", data: "" }],
        additional_info: {
          source: "simulator", channel: "CH1", device_mac: cam?.mac || "8C-1F-64-CC-65-BF",
          alarm_active: true, alarm_subtype: "cd", take_alarm_snap: 732,
        },
      },
    }),
  },

  // ── Access control ─────────────────────────────────────────────────────────
  {
    id: "access_unknown_card",
    label: "Unknown Card Swipe",
    icon: "heroicons-outline:credit-card",
    category: "access",
    requiresCamera: false,
    buildPayload: (cam, site, ac) => {
      const now = iso();
      const cardCode = `SIM-${String(Date.now()).slice(-6)}`;
      const controllerName = ac?.name || "GVD Controller";
      const doorName = `${controllerName}_Reader1`;
      return {
        // event_type is overridden at send-time from the selected Rule's alert_code.
        event_type: "access.card.unknown",
        alarm_type: "unknown_card",
        source_service: "access_control",
        simulator_event: true,
        device_type: "reader",
        device_name: doorName,
        site_id: ac?.site_id || cam?.site_id || "",
        severity: "high",
        timestamp: now,
        cap: {
          event_info: {
            id: `SIM-AC-UNKNOWN-${Date.now()}`,
            type: "unknown_card",
            from: "access_control",
            time: now,
            description: `Unknown card ${cardCode} was presented at ${doorName}`,
            device_id: ac?.id || "GVD-CTRL-1",
            severity: "high",
          },
          location_info: {
            id: ac?.site_id || cam?.site_id || "",
            name: site?.name || "",
            latitude: "",
            longitude: "",
          },
          images: [],
          additional_info: {
            source: "simulator",
            card_label: cardCode,
            cardholder_name: "Unknown",
            door_name: doorName,
          },
        },
        // Matches the payload shape used by the live access SSE feed.
        raw: {
          Type: "3",
          ReaderName: doorName,
          DoorName: "Main Entrance",
          CardCode: cardCode,
          CardholderName: "Unknown",
          AccessDeniedCode: "1024",
          ControllerUID: ac?.id || "GVD-CTRL-1",
          ControllerName: controllerName,
          ControllerIP: ac?.ip || "192.168.1.150",
        },
      };
    },
  },
];

const PRESET_GROUPS = [
  { key: "custom", label: "Custom" },
  { key: "health", label: "Health" },
  { key: "lumina", label: "Lumina analytics" },
  { key: "access", label: "Access control" },
];

const EMPTY_PAYLOAD = "{}";

export default function SimulatorTab() {
  const sitesQ = useQuery({ queryKey: ["sim-sites"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const camerasQ = useQuery({
    queryKey: ["sim-cameras"],
    queryFn: () => vmsInventory.cameras({ limit: 200 }),
    staleTime: 5 * 60 * 1000,
  });
  const accessQ = useQuery({
    queryKey: ["sim-access-controllers"],
    queryFn: () => accessInventory.instances({ limit: 200 }),
    staleTime: 5 * 60 * 1000,
  });
  const rulesQ = useQuery({
    queryKey: ["sim-active-rules"],
    queryFn: () => wfApi.alertFormats.list({ limit: 200 }),
    staleTime: 30 * 1000,
  });

  const sites = asItems(sitesQ.data);
  const cameras = asItems(camerasQ.data);
  const accessControllers = asItems(accessQ.data);

  const sitesById = useMemo(() => {
    const map = {};
    sites.forEach((s) => {
      const id = idOf(s, "site_id", "id");
      if (id) map[id] = s;
    });
    return map;
  }, [sites]);

  const activeRules = useMemo(
    () => asItems(rulesQ.data).filter((r) => r?.is_active !== false),
    [rulesQ.data],
  );
  // Access presets bias the Rule list toward access-shaped alert codes.
  const accessRules = useMemo(() => {
    const looksAccess = (r) => /access|card|door|unknown/.test(
      `${String(r?.alert_code || "")} ${String(r?.name || "")}`.toLowerCase(),
    );
    const scoped = activeRules.filter(looksAccess);
    return scoped.length ? scoped : activeRules;
  }, [activeRules]);

  const [cameraId, setCameraId] = useState("");
  const [accessId, setAccessId] = useState("");
  const [ruleCode, setRuleCode] = useState("");
  const [presetId, setPresetId] = useState(null);

  const [eventType, setEventType] = useState("");
  const [alertCode, setAlertCode] = useState("");
  const [siteId, setSiteId] = useState("");
  const [payloadText, setPayloadText] = useState(EMPTY_PAYLOAD);
  const [dryRun, setDryRun] = useState(true);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);

  const selectedCamera = useMemo(
    () => cameras.find((c) => idOf(c, "id", "camera_id") === cameraId) || null,
    [cameras, cameraId],
  );
  const selectedAccess = useMemo(
    () => accessControllers.find((a) => idOf(a, "id", "instance_id") === accessId) || null,
    [accessControllers, accessId],
  );

  // Rebuild the composer (event_type + payload + site) from a preset and the
  // currently selected camera / access device.
  function rebuild(preset, cam, ac) {
    const camN = camFields(cam);
    const acN = acFields(ac);
    const derivedSiteId = preset.category === "access" ? acN?.site_id : camN?.site_id;
    const site = sitesById[derivedSiteId];
    const payload = preset.buildPayload(camN, site, acN);
    setPayloadText(JSON.stringify(payload, null, 2));
    setEventType(payload.event_type || "");
    if (derivedSiteId) setSiteId(derivedSiteId);
    setErrors({});
  }

  function applyPreset(preset) {
    setPresetId(preset.id);
    const needsCamera = preset.requiresCamera !== false;
    const needsAccess = preset.category === "access";

    let code = ruleCode;
    if (needsAccess && !code) {
      const preferred =
        accessRules.find((r) => String(r.alert_code || "").toLowerCase() === "access.card.unknown") ||
        accessRules[0];
      if (preferred?.alert_code) {
        code = preferred.alert_code;
        setRuleCode(code);
      }
    }
    if (needsAccess) setAlertCode(code || "");

    if ((selectedCamera || !needsCamera) && (!needsAccess || selectedAccess)) {
      rebuild(preset, selectedCamera, selectedAccess);
    } else if (needsAccess) {
      toast.info("Select an access control device first, then pick a scenario");
    } else {
      toast.info("Select a camera first, then pick a scenario");
    }
  }

  function onCameraChange(id) {
    setCameraId(id);
    const preset = PRESETS.find((p) => p.id === presetId);
    if (preset && preset.category !== "access") {
      rebuild(preset, cameras.find((c) => idOf(c, "id", "camera_id") === id) || null, selectedAccess);
    }
  }

  function onAccessChange(id) {
    setAccessId(id);
    const preset = PRESETS.find((p) => p.id === presetId);
    if (preset?.category === "access") {
      rebuild(preset, selectedCamera, accessControllers.find((a) => idOf(a, "id", "instance_id") === id) || null);
    }
  }

  function onRuleChange(code) {
    setRuleCode(code);
    setAlertCode(code);
  }

  function clearComposer() {
    setPayloadText(EMPTY_PAYLOAD);
    setPresetId(null);
    setEventType("");
    setAlertCode("");
    setErrors({});
  }

  const simulate = useMutation({
    mutationFn: (body) => wfApi.simulate(body),
    onSuccess: (res) => {
      setResult(res);
      if (!dryRun && (res?.created_instance_id || res?.created_instance_ids?.length)) {
        toast.success("Incident created");
      } else {
        toast.success("Simulation complete");
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!eventType.trim()) next.eventType = "Event type is required";
    let payload;
    try {
      const t = payloadText.trim();
      payload = t ? JSON.parse(t) : {};
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        next.payload = "Payload must be a JSON object";
      }
    } catch (err) {
      next.payload = `Invalid JSON: ${err.message}`;
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    setErrors({});
    simulate.mutate({
      event_type: eventType.trim(),
      payload,
      site_id: siteId || null,
      alert_code: alertCode.trim() || null,
      dry_run: dryRun,
    });
  }

  const cameraOptions = [
    { value: "", label: camerasQ.isLoading ? "Loading cameras…" : "No camera (skip for access)" },
    ...cameras.map((c) => {
      const f = camFields(c);
      return { value: f.id, label: `${f.name}${f.ip ? ` — ${f.ip}` : ""}${f.brand ? ` (${f.brand})` : ""}` };
    }),
  ];
  const accessOptions = [
    { value: "", label: accessQ.isLoading ? "Loading access devices…" : "No access device" },
    ...accessControllers.map((a) => {
      const f = acFields(a);
      return { value: f.id, label: `${f.name}${f.baseUrl ? ` — ${f.baseUrl}` : ""}` };
    }),
  ];
  const ruleOptions = [
    { value: "", label: "No alert-format (match by event_type only)" },
    ...activeRules.map((r) => ({
      value: r.alert_code || "",
      label: `${r.name || "Rule"} — ${r.alert_code || "(no code)"}`,
    })),
  ];
  const siteOptions = [
    { value: "", label: sitesQ.isLoading ? "Loading sites…" : "No site" },
    ...sites.map((s) => ({ value: idOf(s, "site_id", "id"), label: s.name })),
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ── Composer ─────────────────────────────────────────────── */}
      <form onSubmit={submit} className="rounded-xl border border-card-border bg-card">
        <header className="px-5 py-4 border-b border-card-border">
          <h3 className="text-sm font-semibold text-foreground">Event composer</h3>
          <p className="text-xs text-muted">
            Pick a device + scenario, or hand-craft a payload, then run it through trigger + format matching.
          </p>
        </header>
        <div className="px-5 py-4 space-y-4">
          {/* Devices */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field
              as="select"
              label="Camera"
              value={cameraId}
              onChange={(e) => onCameraChange(e.target.value)}
              options={cameraOptions}
            />
            <Field
              as="select"
              label="Access control device"
              value={accessId}
              onChange={(e) => onAccessChange(e.target.value)}
              options={accessOptions}
            />
          </div>

          {/* Scenario presets */}
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted">Scenario</label>
            <div className="mt-1.5 space-y-2.5">
              {PRESET_GROUPS.map((g) => {
                const items = PRESETS.filter((p) => p.category === g.key);
                if (!items.length) return null;
                return (
                  <div key={g.key}>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted/70 mb-1">{g.label}</p>
                    <div className="flex flex-wrap gap-2">
                      {items.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => applyPreset(p)}
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                            presetId === p.id
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-card-border text-foreground hover:bg-hover"
                          }`}
                        >
                          <Icon icon={p.icon} className="text-sm" /> {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rule (alert-format) → alert_code */}
          <Field
            as="select"
            label="Rule (alert-format)"
            hint="Access events run a SOP via the selected rule's alert code."
            value={ruleCode}
            onChange={(e) => onRuleChange(e.target.value)}
            options={ruleOptions}
          />

          {/* Composer fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field
              label="Event type"
              required
              value={eventType}
              onChange={(e) => {
                setEventType(e.target.value);
                if (errors.eventType) setErrors((p) => ({ ...p, eventType: undefined }));
              }}
              placeholder="e.g. motion, offline, lp"
              className="font-mono"
              error={errors.eventType}
            />
            <Field
              label="Alert code"
              value={alertCode}
              onChange={(e) => setAlertCode(e.target.value)}
              placeholder="Optional — match an alert format"
              className="font-mono"
            />
          </div>

          <Field
            as="select"
            label="Site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            options={siteOptions}
          />

          <Field
            as="textarea"
            rows={10}
            label="Payload (JSON)"
            value={payloadText}
            onChange={(e) => {
              setPayloadText(e.target.value);
              if (errors.payload) setErrors((p) => ({ ...p, payload: undefined }));
            }}
            className="font-mono text-xs"
            placeholder='{ "severity": "high" }'
            error={errors.payload}
          />

          <label
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition ${
              dryRun ? "border-card-border bg-hover/40" : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Dry run</span>
              <span className="block text-[11px] text-muted">
                {dryRun
                  ? "Match only — no incident is created."
                  : "Live — a matching format/trigger will create a REAL incident."}
              </span>
            </span>
          </label>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={clearComposer}
              className="rounded-md border border-card-border px-3 py-2 text-sm text-muted transition hover:bg-hover"
            >
              Clear
            </button>
            <Button
              type="submit"
              disabled={simulate.isPending}
              icon={dryRun ? "heroicons-outline:beaker" : "heroicons-outline:bolt"}
              variant={dryRun ? "primary" : "danger"}
              className="!px-3.5 !py-2 text-sm"
            >
              {simulate.isPending ? "Simulating…" : dryRun ? "Simulate" : "Run live"}
            </Button>
          </div>
        </div>
      </form>

      {/* ── Result ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-card-border bg-card">
        <header className="px-5 py-4 border-b border-card-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Result</h3>
            <p className="text-xs text-muted">What the event matched.</p>
          </div>
          {result && <Badge color={result.dry_run ? "blue" : "amber"}>{result.dry_run ? "Dry run" : "Live"}</Badge>}
        </header>
        <div className="px-5 py-4">
          {simulate.isPending ? (
            <div className="text-sm text-muted flex items-center gap-2">
              <Spinner className="!h-4 !w-4" /> Simulating…
            </div>
          ) : !result ? (
            <div className="py-10 text-center text-sm text-muted">
              <Icon icon="heroicons-outline:beaker" className="mx-auto mb-2 text-2xl text-muted/60" />
              Run a simulation to see matches.
            </div>
          ) : (
            <ResultPanel result={result} />
          )}
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ result }) {
  const triggers = result.matched_triggers || [];
  const skipped = result.skipped || [];
  const fmt = result.matched_format;
  const createdIds = result.created_instance_ids?.length
    ? result.created_instance_ids
    : result.created_instance_id
      ? [result.created_instance_id]
      : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted font-mono">
        <span className="rounded bg-hover px-1.5 py-0.5">{result.event_type || "—"}</span>
        {result.alert_code && <span className="rounded bg-hover px-1.5 py-0.5">code: {result.alert_code}</span>}
      </div>

      {/* Matched triggers */}
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted mb-1.5">
          Matched triggers ({triggers.length})
        </h4>
        {triggers.length === 0 ? (
          <p className="text-[11px] text-muted/70">No triggers matched.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {triggers.map((t, i) => (
              <li key={t.trigger_id || i} className="flex items-center gap-2 px-3 py-2">
                <Icon icon="heroicons:bolt" className="text-amber-500 text-sm shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-foreground truncate">{t.name || t.trigger_id}</span>
                  {t.sop_id && <span className="block text-[11px] text-muted font-mono truncate">→ SOP {t.sop_id}</span>}
                </span>
                {t.would_create ? (
                  <Icon icon="heroicons-solid:check-circle" className="text-green-500 text-base shrink-0" title="Would create" />
                ) : (
                  <Icon icon="heroicons-outline:minus-circle" className="text-muted text-base shrink-0" title="Would not create" />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Matched format */}
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted mb-1.5">Matched format</h4>
        {!fmt ? (
          <p className="text-[11px] text-muted/70">No alert format matched.</p>
        ) : (
          <div className="rounded-lg border border-card-border px-3 py-2.5 flex items-center gap-2">
            <Icon icon="heroicons-outline:swatch" className="text-blue-500 text-base shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-foreground">{fmt.name || fmt.alert_code}</span>
                {fmt.sop_mode && <Badge color="blue">{fmt.sop_mode}</Badge>}
              </span>
              <span className="block text-[11px] text-muted font-mono truncate">
                {fmt.alert_code}
                {fmt.sop_id ? ` → SOP ${fmt.sop_id}` : ""}
              </span>
            </span>
            {fmt.would_create ? (
              <Icon icon="heroicons-solid:check-circle" className="text-green-500 text-base shrink-0" title="Would create" />
            ) : (
              <Icon icon="heroicons-outline:minus-circle" className="text-muted text-base shrink-0" title="Would not create" />
            )}
          </div>
        )}
      </section>

      {/* Skipped */}
      {skipped.length > 0 && (
        <section>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted mb-1.5">Skipped ({skipped.length})</h4>
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {skipped.map((s, i) => (
              <li key={i} className="flex items-start gap-2 px-3 py-2">
                <Icon icon="heroicons-outline:no-symbol" className="text-muted text-sm shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-muted font-mono truncate">{s.trigger_id || s.format_id || "—"}</span>
                  <span className="block text-xs text-foreground">{s.reason || "Skipped"}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Created incident (live) */}
      {createdIds.length > 0 && (
        <section className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-green-500 mb-1.5">Incident created</h4>
          <ul className="space-y-1">
            {createdIds.map((id) => (
              <li key={id}>
                <Link href={`/events/${id}`} className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline font-mono">
                  <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-sm" /> {id}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
