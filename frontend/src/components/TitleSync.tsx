"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import type { BrandingOut } from "@/lib/types";

// Owns the BROWSER TAB: the title and the icon, both from branding.
//
// They live together because they are one thing to a reader — the tab — and
// because they need the same fix: Next re-applies the static route metadata on
// every navigation, so both are re-asserted on `pathname`.
//
// The icon is a link element we manage by id, appended LAST so it wins over the
// one Next emits from app/icon.svg (browsers take the last matching `rel="icon"`).
// When a tenant has no favicon the element is REMOVED rather than pointed at
// nothing, which is what lets the app's own icon come back.
const FAVICON_ID = "brand-favicon";

export default function TitleSync() {
  const pathname = usePathname();
  const { data } = useQuery<BrandingOut>({
    queryKey: ["branding"],
    queryFn: () => api.get<BrandingOut>("/branding").then((r) => r.data),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (data?.app_name) document.title = data.app_name;
  }, [data?.app_name, pathname]);

  useEffect(() => {
    const url = data?.favicon_url;
    const existing = document.getElementById(FAVICON_ID);
    if (!url) {
      existing?.remove();
      return;
    }
    const link = (existing as HTMLLinkElement | null) ?? document.createElement("link");
    link.id = FAVICON_ID;
    link.rel = "icon";
    if (link.href !== url) link.href = url;
    // Re-appending moves it to the end, which is what keeps it ahead of Next's own
    // icon link after a navigation re-inserts that one.
    document.head.appendChild(link);
  }, [data?.favicon_url, pathname]);

  return null;
}
