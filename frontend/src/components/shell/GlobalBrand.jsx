"use client";

// Global brand mark (header-less era). The retired <Header> carried the NeuBit
// logo top-left; this restores it as a fixed floating lockup so every screen keeps
// the brand + a one-click route back to the HOME launcher. Honors a tenant's
// uploaded logo (from /branding) exactly like the old header did; otherwise the
// default "NeuBit" wordmark ("Neu" white, "Bit" teal) + tagline.
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { api } from "@/lib/api";

export default function GlobalBrand() {
  const { data } = useQuery({
    queryKey: ["branding"],
    queryFn: () => api.get("/branding").then((r) => r.data),
    staleTime: 60_000,
  });
  const logo = data?.logo_url;

  return (
    <Link
      href="/home"
      title="Home"
      className="flex items-center gap-2.5 rounded-[8px] px-1.5 py-1 transition hover:opacity-90"
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={data?.app_name || "Logo"} className="h-6 max-w-[150px] object-contain" />
      ) : (
        <span className="flex flex-col leading-none">
          <span className="text-[17px] font-bold tracking-[0.3px]">
            <span className="text-[#f2f6ff]">Neu</span>
            <span className="text-[#67e8f9]">Bit</span>
          </span>
          <span className="mt-0.5 font-mono text-[7px] uppercase tracking-[1.6px] text-[#9a92c8]">
            Listen to your data
          </span>
        </span>
      )}
    </Link>
  );
}
