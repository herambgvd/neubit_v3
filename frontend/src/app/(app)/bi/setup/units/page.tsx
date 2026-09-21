import { redirect } from "next/navigation";

import { LEGACY_SETUP_ROUTES, carryQuery } from "@/features/bi/setup/routes";

// Duplicates and Units were gates of their own until the gateway became the
// place a signal is described: it keeps its point ids across a rebuild, so
// nothing duplicates, and it carries the unit on every envelope. Kept as a
// redirect so bookmarks and old deep links land on Setup rather than 404.
export default async function R({
  searchParams,
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  redirect(carryQuery(LEGACY_SETUP_ROUTES["/bi/setup/units"]!, await searchParams));
}
