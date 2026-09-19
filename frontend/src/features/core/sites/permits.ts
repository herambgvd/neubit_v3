// What a caller may actually DO on the Sites screens.
//
// WHY THIS EXISTS. Core gates every write on its own key — `floors.create`,
// `floors.update`, `floors.delete`, `zones.update`, `zones.delete`,
// `sites.update`, `sites.delete` — so nothing here is a security boundary: a
// caller without the key is refused by the server whatever the screen shows.
// What the screen was doing was offering the press anyway. A control that can
// only ever end in a 403 is a promise the product cannot keep, and this console
// does not ship those (the same rule that took Acknowledge off a viewer's alert
// list and the write controls off a read-only BI screen).
//
// One helper rather than seven `can(...)` calls scattered through four
// components, so a key that changes is changed once and a control that is added
// later has an obvious place to ask.
export const SITE_PERMS = {
  siteUpdate: "sites.update",
  siteDelete: "sites.delete",
  floorCreate: "floors.create",
  floorUpdate: "floors.update",
  floorDelete: "floors.delete",
  zoneUpdate: "zones.update",
  zoneDelete: "zones.delete",
} as const;

export interface SitePermits {
  /** Edit the building's own record, restore it, change its threat level. */
  editSite: boolean;
  deleteSite: boolean;
  addFloor: boolean;
  /** Rename a floor, and open the floor-plan editor, which writes to it. */
  editFloor: boolean;
  deleteFloor: boolean;
  editZone: boolean;
  deleteZone: boolean;
}

/** Build the permits from whatever `useAuth().can` this screen already has. */
export function sitePermits(can: (p: string) => boolean): SitePermits {
  return {
    editSite: can(SITE_PERMS.siteUpdate),
    deleteSite: can(SITE_PERMS.siteDelete),
    addFloor: can(SITE_PERMS.floorCreate),
    editFloor: can(SITE_PERMS.floorUpdate),
    deleteFloor: can(SITE_PERMS.floorDelete),
    editZone: can(SITE_PERMS.zoneUpdate),
    deleteZone: can(SITE_PERMS.zoneDelete),
  };
}
