"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Static footer pinned to the bottom of the app shell (only the main content
// between the header and this footer scrolls). Uses the white-label app name.
export default function Footer() {
  const { data } = useQuery({
    queryKey: ["branding"],
    queryFn: () => api.get("/branding").then((r) => r.data),
    staleTime: 60_000,
  });
  const name = data?.app_name || "Neubit";
  const year = new Date().getFullYear();

  return (
    // No backdrop-blur — see GlobalNavDock: in-flow chrome with nothing behind it,
    // and the blur only made the bar a backdrop root an overlay could not dim through.
    <footer className="shrink-0 border-t border-[rgba(150,180,245,.14)] bg-[rgba(8,15,34,.55)]">
      <div className="w-full px-6 lg:px-8 py-2.5 flex items-center justify-between">
        <span className="text-[11px] tracking-[.2px] text-nb-faint">
          © {year} {name}. All rights reserved.
        </span>
        {/* GVD lockup — right corner, matching the VMS console mockup. */}
        <div className="flex items-center gap-2.5 opacity-80">
          <span className="hidden text-[10px] font-medium uppercase tracking-[2.5px] text-[#9fb2d8] sm:inline">
            Genius Vision Digital
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo/gvd_logo_color.png"
            alt="Genius Vision Digital"
            className="h-4 w-auto shrink-0"
          />
        </div>
      </div>
    </footer>
  );
}
