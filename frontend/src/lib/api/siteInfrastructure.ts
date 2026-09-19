"use client";

// Site infrastructure — a site's equipment registry (core,
// backend/core/app/sites/infrastructure/router.py).
//
//   SYSTEM     on a site (a chilled-water loop, an AHU fleet); its kind is fixed.
//   EQUIPMENT  in a system (a chiller, a pump) with nameplate DESIGN facts.
//   SLOTS      on equipment, each bound to one gateway point by device + point tag.
//
// Read needs `sites.read`, every write `sites.update`.
//
// Two calls here are easy to misuse, so their signatures make the safe use the
// only one:
//   • `setDesign` REPLACES the whole fact set — a fact left out is cleared. Call
//     it with the equipment's current design merged with the edit (see
//     `mergeDesign` in the designer), never with the one field that changed.
//   • `importSchedule` takes `dryRun` as a REQUIRED argument. The server defaults
//     to a dry run, but a client that decides to write must say so in the call.
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type {
  CreateEquipmentRequest,
  CreateSystemRequest,
  DesignUpdate,
  EquipmentPublic,
  InfraImportReport,
  InfraVocabulary,
  InfrastructureTree,
  PointBinding,
  SiteSystemPublic,
  UpdateEquipmentRequest,
  UpdateSystemRequest,
} from "@/lib/types";

const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);

const base = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/infrastructure`;
const seg = encodeURIComponent;

export const siteInfrastructure = {
  /** The closed vocabulary. Every picker on the designer is built from this. */
  vocabulary: () => unwrap(api.get<InfraVocabulary>("/site-infrastructure/vocabulary")),

  tree: (siteId: string) => unwrap(api.get<InfrastructureTree>(base(siteId))),

  createSystem: (siteId: string, body: CreateSystemRequest) =>
    unwrap(api.post<SiteSystemPublic>(`${base(siteId)}/systems`, body)),
  updateSystem: (siteId: string, systemId: string, body: UpdateSystemRequest) =>
    unwrap(api.patch<SiteSystemPublic>(`${base(siteId)}/systems/${seg(systemId)}`, body)),
  /** Cascades: the system's equipment and their slots go with it. */
  deleteSystem: (siteId: string, systemId: string) =>
    unwrap(api.delete<void>(`${base(siteId)}/systems/${seg(systemId)}`)),

  createEquipment: (siteId: string, body: CreateEquipmentRequest) =>
    unwrap(api.post<EquipmentPublic>(`${base(siteId)}/equipment`, body)),
  updateEquipment: (siteId: string, equipmentId: string, body: UpdateEquipmentRequest) =>
    unwrap(api.patch<EquipmentPublic>(`${base(siteId)}/equipment/${seg(equipmentId)}`, body)),
  /** REPLACES the whole set. See the note at the top of this file. */
  setDesign: (siteId: string, equipmentId: string, body: DesignUpdate) =>
    unwrap(api.put<EquipmentPublic>(`${base(siteId)}/equipment/${seg(equipmentId)}/design`, body)),
  /** Both tags, or both null (the slot stays declared, unbound). */
  setSlot: (siteId: string, equipmentId: string, slot: string, body: Required<PointBinding>) =>
    unwrap(
      api.put<EquipmentPublic>(`${base(siteId)}/equipment/${seg(equipmentId)}/slots/${seg(slot)}`, body),
    ),
  removeSlot: (siteId: string, equipmentId: string, slot: string) =>
    unwrap(api.delete<EquipmentPublic>(`${base(siteId)}/equipment/${seg(equipmentId)}/slots/${seg(slot)}`)),
  deleteEquipment: (siteId: string, equipmentId: string) =>
    unwrap(api.delete<void>(`${base(siteId)}/equipment/${seg(equipmentId)}`)),

  /** Parse an I/O schedule. `dryRun: true` writes nothing and returns the plan;
   *  `false` writes exactly that plan in one commit. */
  importSchedule: (siteId: string, file: File | Blob, dryRun: boolean) => {
    const fd = new FormData();
    fd.append("file", file);
    return unwrap(
      api.post<InfraImportReport>(`${base(siteId)}/import?dry_run=${dryRun ? "true" : "false"}`, fd),
    );
  },
};

export default siteInfrastructure;
