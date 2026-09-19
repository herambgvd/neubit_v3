import { redirect } from "next/navigation";

import { LEGACY_SETUP_ROUTES, carryQuery } from "@/features/bi/setup/routes";

// Moved into Building Intelligence → Setup. Kept as a redirect so bookmarks and
// old deep links land on the same screen, with their query intact.
export default async function R({
  searchParams,
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  redirect(carryQuery(LEGACY_SETUP_ROUTES["/bi/succession"]!, await searchParams));
}
