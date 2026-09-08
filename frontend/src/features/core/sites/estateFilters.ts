// Map filters. Separate from the page so they can be tested without a canvas.
import type { SiteWithCoords } from "./constants";
import { opsSeverity, type SiteOps } from "./estateRollup";

/**
 * The sites an operator would act on: unacknowledged alarms, or cameras that
 * have gone dark.
 *
 * NOT the threat level. That is a posture an operator set by hand and left set —
 * filtering on it would hide a normal-posture site whose cameras are all down,
 * which is precisely the site someone opened this map to find.
 */
export function needsAttentionOnly(
  sites: SiteWithCoords[],
  bySite: Map<string, SiteOps>,
): SiteWithCoords[] {
  return sites.filter((s) => opsSeverity(bySite.get(s.site_id)) !== "normal");
}
