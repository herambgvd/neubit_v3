"use client";

// Sites API module — sites / floors / zones CRUD + tree + threat-level + uploads.
// Ported from neubit_v2's lib/api/sites.js and adapted to neubit_v3's axios client:
//   • neubit_v2 used bespoke get/post helpers that returned the raw body; here we
//     wrap the shared `api` axios instance (baseURL already "/api/v1") and unwrap
//     `.data` so callers keep receiving plain objects.
//   • Paths are relative to /api/v1 → "/sites", "/floors", "/zones",
//     "/device-placements" (all served by the core service).
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type {
  BuildingFactsUpdate,
  CreateFloorRequest,
  CreateSiteRequest,
  CreateZoneRequest,
  DevicePlacementListResponse,
  DevicePlacementPublic,
  EmissionFactorIn,
  EmissionFactorListResponse,
  FloorPublic,
  Paged,
  QueryParams,
  RegisterDeviceRequest,
  SitePublic,
  SiteTreeNode,
  TariffSlabIn,
  TariffSlabListResponse,
  ThreatLevel,
  UpdateDeviceRequest,
  UpdateFloorRequest,
  UpdateSiteRequest,
  UpdateZoneRequest,
  ZonePublic,
} from "@/lib/types";

const SITES = "/sites";
const FLOORS = "/floors";
const ZONES = "/zones";
const DEVICE_PLACEMENTS = "/device-placements";

const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);

// Drop null/undefined/"" so URLSearchParams doesn't emit empty filters.
function qs(params: QueryParams = {}): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

/** `POST /floors/upload` — a floor's fields plus the plan image, multipart. */
export interface CreateFloorWithUpload extends CreateFloorRequest {
  file?: File | Blob | null;
}

function floorFormData(fields: Omit<CreateFloorWithUpload, "file">, file?: File | Blob | null): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
  }
  if (file) fd.append("file", file);
  return fd;
}

export const sites = {
  list: (params: QueryParams = {}) => unwrap(api.get<Paged<SitePublic>>(`${SITES}${qs(params)}`)),
  tree: () => unwrap(api.get<SiteTreeNode[]>(`${SITES}/tree`)),
  get: (id: string) => unwrap(api.get<SitePublic>(`${SITES}/${id}`)),
  create: (body: CreateSiteRequest) => unwrap(api.post<SitePublic>(SITES, body)),
  update: (id: string, body: UpdateSiteRequest) => unwrap(api.patch<SitePublic>(`${SITES}/${id}`, body)),
  remove: (id: string) => unwrap(api.delete<void>(`${SITES}/${id}`)),
  restore: (id: string) => unwrap(api.post<SitePublic>(`${SITES}/${id}/restore`, {})),
  // The BUILDING FACTS — gross floor area, energy tariff, occupancy.
  //
  // A PUT with all four fields, not a PATCH: `update()` above is applied with
  // `exclude_none=True` on the server, so on that path a null is
  // indistinguishable from "not mentioned" and a recorded area could never be
  // taken back. Here an explicit null CLEARS, and the site returns to "no area
  // recorded" — the state Building Intelligence → Ratings renders instead of a
  // score. Send all four every time.
  //
  // Nothing infers these. They are what an operator typed, and they are what a
  // rating divides by, which is exactly why they live here beside the address
  // rather than on a BI screen of their own.
  setBuildingFacts: (id: string, body: BuildingFactsUpdate) =>
    unwrap(api.put<SitePublic>(`${SITES}/${id}/building-facts`, body)),
  // TIME-OF-USE TARIFF SLABS and EMISSION FACTORS (core migration 0019) — the
  // other two Building Intelligence inputs, edited on the same Building tab.
  //
  // Both PUTs are FULL REPLACES of the whole list, for the same reason
  // building-facts is a PUT: a PATCH built on exclude_none cannot say "take
  // this back". An explicit empty list CLEARS the set — for slabs that means
  // the scalar tariff above is in effect again; for factors it means no CO2
  // figure at all. PRECEDENCE: when any slab is in effect for a date, the
  // slabs override the scalar ENTIRELY; an hour no slab covers has no price.
  // Nothing here defaults or seeds a value — the tables ship empty.
  getTariffSlabs: (id: string) => unwrap(api.get<TariffSlabListResponse>(`${SITES}/${id}/tariff-slabs`)),
  setTariffSlabs: (id: string, slabs: TariffSlabIn[]) =>
    unwrap(api.put<TariffSlabListResponse>(`${SITES}/${id}/tariff-slabs`, { slabs })),
  getEmissionFactors: (id: string) =>
    unwrap(api.get<EmissionFactorListResponse>(`${SITES}/${id}/emission-factors`)),
  setEmissionFactors: (id: string, factors: EmissionFactorIn[]) =>
    unwrap(api.put<EmissionFactorListResponse>(`${SITES}/${id}/emission-factors`, { factors })),
  setThreatLevel: (id: string, level: ThreatLevel) =>
    unwrap(api.put<SitePublic>(`${SITES}/${id}/threat-level`, { threat_level: level })),
  uploadImage: (id: string, file: File | Blob) => {
    const fd = new FormData();
    fd.append("file", file);
    return unwrap(api.post<SitePublic>(`${SITES}/${id}/image`, fd));
  },

  floors: {
    list: (params: QueryParams = {}) => unwrap(api.get<Paged<FloorPublic>>(`${FLOORS}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<FloorPublic>(`${FLOORS}/${id}`)),
    create: (body: CreateFloorRequest) => unwrap(api.post<FloorPublic>(FLOORS, body)),
    createWithUpload: ({ site_id, name, file, ...rest }: CreateFloorWithUpload) =>
      unwrap(api.post<FloorPublic>(`${FLOORS}/upload`, floorFormData({ site_id, name, ...rest }, file))),
    update: (id: string, body: UpdateFloorRequest) =>
      unwrap(api.patch<FloorPublic>(`${FLOORS}/${id}`, body)),
    replaceFloorplan: (id: string, file: File | Blob) => {
      const fd = new FormData();
      fd.append("file", file);
      return unwrap(api.post<FloorPublic>(`${FLOORS}/${id}/floorplan`, fd));
    },
    remove: (id: string) => unwrap(api.delete<void>(`${FLOORS}/${id}`)),
    restore: (id: string) => unwrap(api.post<FloorPublic>(`${FLOORS}/${id}/restore`, {})),
  },

  zones: {
    list: (params: QueryParams = {}) => unwrap(api.get<Paged<ZonePublic>>(`${ZONES}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<ZonePublic>(`${ZONES}/${id}`)),
    create: (body: CreateZoneRequest) => unwrap(api.post<ZonePublic>(ZONES, body)),
    update: (id: string, body: UpdateZoneRequest) => unwrap(api.patch<ZonePublic>(`${ZONES}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${ZONES}/${id}`)),
    restore: (id: string) => unwrap(api.post<ZonePublic>(`${ZONES}/${id}/restore`, {})),
  },

  // Device placements — a device pinned onto a floor at { x, y, rotation }.
  // Addressed by `device_id`; `register` is an upsert-by-device_id within the
  // tenant. Served by the core service under /api/v1/device-placements.
  devicePlacements: {
    register: (body: RegisterDeviceRequest) =>
      unwrap(api.post<DevicePlacementPublic>(`${DEVICE_PLACEMENTS}/register`, body)),
    get: (deviceId: string) => unwrap(api.get<DevicePlacementPublic>(`${DEVICE_PLACEMENTS}/${deviceId}`)),
    update: (deviceId: string, body: UpdateDeviceRequest) =>
      unwrap(api.patch<DevicePlacementPublic>(`${DEVICE_PLACEMENTS}/${deviceId}`, body)),
    remove: (deviceId: string) => unwrap(api.delete<void>(`${DEVICE_PLACEMENTS}/${deviceId}`)),
    listByFloor: (floorId: string, params: QueryParams = {}) =>
      unwrap(api.get<DevicePlacementListResponse>(`${DEVICE_PLACEMENTS}/by-floor/${floorId}${qs(params)}`)),
    listByZone: (zoneId: string) =>
      unwrap(api.get<DevicePlacementListResponse>(`${DEVICE_PLACEMENTS}/by-zone/${zoneId}`)),
  },
};

export default sites;
