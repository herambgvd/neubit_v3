import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { BiSiteFactsListResponse } from "@/lib/types";

import { bi } from "../api";

/** Active buildings, in the mirror's order. Shared with the checklist so both
 *  count the same buildings. */
export function useBuildings(enabled = true) {
  const q = useQuery<BiSiteFactsListResponse>({
    queryKey: ["bi-rating-sites"],
    queryFn: () => bi.ratingSites(),
    enabled,
  });
  const items = useMemo(() => (q.data?.items ?? []).filter((s) => s.is_active !== false), [q.data]);
  return { q, items };
}
