// GATE 6's route, in one place so the strip, the gate model and any future
// caller cannot drift apart about where work is raised.
//
// It carries `?site=` the way every other building-scoped BI route does: a
// building's equipment findings come from a per-site endpoint, and alerts are
// estate-wide and say so on the screen.
export const WORK_HREF = "/bi/work";

export const workHrefFor = (siteId?: string | null): string =>
  siteId ? `${WORK_HREF}?site=${siteId}` : WORK_HREF;
