import { redirect } from "next/navigation";

import { LEGACY_SETUP_ROUTES, carryQuery } from "@/features/bi/setup/routes";

// Answers stranded on a reading that stopped coming are settled on Metric roles
// now, beside the other answers about the same device. The path stays so a
// bookmark and the old checklist link still land somewhere real.
export default async function Page({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  redirect(carryQuery(LEGACY_SETUP_ROUTES["/bi/setup/stranded"]!, await searchParams));
}
