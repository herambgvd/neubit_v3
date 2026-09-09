// Permission keys and timings for the DashForge embed surface.

/** Gated by core's dashforge module (`backend/core/app/dashforge/router.py`),
 *  registered in core's catalog so a role can actually grant them.
 *
 *  READ is not a formality here. DashForge's `/public/embed/:token` is
 *  UNAUTHENTICATED — the token IS the credential — so the only check standing in
 *  front of that data is the one NeuBit makes before minting. A caller without
 *  this key never receives a token, and the console has nothing to put in an
 *  iframe. MANAGE decides which dashboards are registered at all. */
export const PERM_READ = "dashforge.read";
export const PERM_MANAGE = "dashforge.manage";

/** Module the routes are gated by — "Dashboards & Reports". The same entitlement
 *  the rest of Building Intelligence rides. */
export const MODULE = "analytics";

/** How long before a session token expires to mint the next one, in ms.
 *
 *  The lifetime itself is the SERVER's decision (VE_DASHFORGE_TOKEN_TTL_MINUTES,
 *  reasoned about in `backend/core/app/dashforge/client.py`); this is only the
 *  margin. 60s covers a slow re-mint and a clock a minute out of step without
 *  the iframe ever reloading onto a dead token, which the embed page renders as
 *  a bare "link expired" — correct, and alarming to somebody who did nothing
 *  wrong. */
export const REMINT_MARGIN_MS = 60_000;

/** Floor on the re-mint timer. Without it a token whose expiry has already
 *  passed (a laptop resumed from sleep) would schedule at a negative delay and
 *  re-mint in a tight loop. */
export const REMINT_MIN_MS = 5_000;

/** Which console shows a registered dashboard.
 *
 *  MIRRORS `backend/core/app/dashforge/categories.py` — same slugs, same order,
 *  and `categories.test.ts` reads that file and fails if the two drift. The set
 *  is closed on both sides for one reason: a category no tab names is a
 *  dashboard that is registered, listed by nothing, and reachable only by its
 *  direct link.
 *
 *  The icon is this side's own — the backend has no view of the console's
 *  iconography and should not grow one. */
export const CATEGORIES: { slug: string; label: string; icon: string }[] = [
  { slug: "building", label: "Building Intelligence", icon: "heroicons:building-office-2" },
  { slug: "vms", label: "Surveillance", icon: "heroicons:video-camera" },
  { slug: "access", label: "Access Control", icon: "heroicons:key" },
  { slug: "workflow", label: "Workflow", icon: "heroicons:rectangle-stack" },
  { slug: "general", label: "General", icon: "heroicons:squares-2x2" },
];

/** What a registration gets when nobody chose — visible under "General" rather
 *  than filed nowhere. Must match the backend's DEFAULT_CATEGORY. */
export const DEFAULT_CATEGORY = "general";

/** The operator-facing label for a slug. An unknown slug (a row written before a
 *  category was retired, say) shows its raw value rather than disappearing. */
export function categoryLabel(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}
