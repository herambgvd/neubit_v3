"use client";

import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import CommandPalette from "@/components/CommandPalette";
import { FullPageLoader } from "@/components/ui/kit";
import Footer from "@/components/shell/Footer";
import Header from "@/components/shell/Header";
import SectionTabs from "@/components/shell/SectionTabs";
import { useAuth } from "@/lib/auth";
import {
  isConfigRoute,
  isDevicesRoute,
  isStreamingRoute,
  configTabs,
  deviceTabs,
  streamTabs,
} from "@/config/menu";

// A banner shown to every signed-in user when an admin sets an announcement.
function AnnouncementBanner() {
  const { data } = useQuery({
    queryKey: ["public-settings"],
    queryFn: () => api.get("/settings/public").then((r) => r.data),
    staleTime: 30_000,
  });
  const text = data?.announcement?.trim();
  if (!text) return null;
  return (
    <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 text-amber-500">
      <div className="w-full px-6 lg:px-8 py-2 flex items-center gap-2 text-[13px]">
        <Icon icon="heroicons-outline:megaphone" className="text-base shrink-0" />
        <span className="truncate">{text}</span>
      </div>
    </div>
  );
}

// Auth-guarded application shell: horizontal top nav + full-width content.
export default function AppLayout({ children }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anon") router.replace("/login");
  }, [status, router]);

  if (status !== "authed") {
    return <FullPageLoader label={status === "anon" ? "Redirecting" : "Loading"} />;
  }

  // Full-height shell: header + footer stay fixed, only <main> scrolls. The Config
  // sub-tab bar appears under the header whenever we're inside the Config section.
  return (
    <div className="h-screen flex flex-col bg-background">
      <Header />
      {isConfigRoute(pathname) && <SectionTabs tabs={configTabs} />}
      {isDevicesRoute(pathname) && <SectionTabs tabs={deviceTabs} />}
      {isStreamingRoute(pathname) && <SectionTabs tabs={streamTabs} />}
      <AnnouncementBanner />
      <main className="flex-1 overflow-y-auto w-full px-6 lg:px-8 py-6">{children}</main>
      <Footer />
      <CommandPalette />
    </div>
  );
}
