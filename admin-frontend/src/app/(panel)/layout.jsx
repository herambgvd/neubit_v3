"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, LayoutDashboard, LogOut, ShieldCheck, UserCircle } from "lucide-react";

import { tokens } from "@/lib/api";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tenants", label: "Tenants", icon: Building2 },
  { href: "/profile", label: "Profile", icon: UserCircle },
];

// Authed shell for the super-admin panel: guards the session (no token → /login)
// and frames every panel page with a top bar (brand + nav + logout).
export default function PanelLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!tokens.access) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  function logout() {
    tokens.clear();
    router.replace("/login");
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-slate-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-slate-200">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-black/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <Link href="/dashboard" className="inline-flex shrink-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-6 w-auto invert brightness-0" />
            <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-cyan-300 sm:inline-flex">
              <ShieldCheck className="h-3.5 w-3.5" />
              Super-admin
            </span>
          </Link>

          <nav className="flex flex-1 items-center gap-1">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  className={
                    "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition " +
                    (active
                      ? "bg-white/10 font-medium text-white"
                      : "text-slate-400 hover:bg-white/5 hover:text-white")
                  }
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </nav>

          <button
            onClick={logout}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" />
            Log out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
