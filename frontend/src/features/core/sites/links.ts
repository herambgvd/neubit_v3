// Deep links INTO the Sites console, for screens elsewhere that send an operator
// to fix something the site owns.

/** The infra designer — Sites → a site → Equipment, optionally opened on one
 *  piece of equipment. Building Intelligence uses this when a chiller has no
 *  design ΔT band or no TR on file: the fact is recorded here, not there. */
export function infraDesignerHref(siteId: string, equipmentId?: string | null): string {
  const q = new URLSearchParams({ site: siteId, tab: "equipment" });
  if (equipmentId) q.set("equipment", equipmentId);
  return `/sites?${q.toString()}`;
}
