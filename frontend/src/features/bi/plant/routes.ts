// L3 PLANT's address. One building's plant, so the building is the query —
// `?site=` is the same parameter L2 is scoped with, which is what lets the
// console strip carry a building from a domain to its plant and back.
export const PLANT_HREF = "/bi/plant";

export const plantHref = (siteId: string): string =>
  `${PLANT_HREF}?${new URLSearchParams({ site: siteId }).toString()}`;
