"use client";

// Global floating control dock (header-less era). The product moved to an
// immersive, chrome-free UI (like the video wall): there is NO global top-nav
// header anymore. Navigation happens via the ⊞ MENU navigator overlay + the Home
// launcher. This compact cluster floats top-right on every authenticated screen
// and re-provides the essential header controls that the retired <Header> carried:
//   • the ⊞ MENU navigator launcher (jump to any section),
//   • a Search / ⌘K trigger (opens the global CommandPalette),
//   • the notifications bell (unread badge + recent dropdown),
//   • the account menu (Account, theme toggle, avatar, Sign out),
//   • on HOME only, the status strip (mode · clock · lock · fullscreen).
// It is deliberately minimal — a floating pill, not a bar — to match the
// immersive wall's floating controls and the navy aesthetic.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";
import { Avatar } from "@/components/ui/kit";
import MenuNavigator from "@/components/shell/MenuNavigator";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/components/theme";

/* HOME status strip — mode label + live clock + lock + fullscreen. Shown only on
   the launcher. Inline SVGs so the chrome renders even offline. Honest: BASELINE
   is a static default-mode label + a real clock; no fabricated figures. */
const HSS = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
function HomeStatusStrip() {
  const [now, setNow] = useState("");
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const tick = () => setNow(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onFs = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  };
  const tiny =
    "grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[#22d3ee] hover:text-[#67e8f9]";

  return (
    <div className="mr-1 flex items-center gap-2">
      <span className="font-mono text-[13px] text-[#aec2e8]">{now}</span>
      <button type="button" title="Lock console" className={tiny}>
        <svg viewBox="0 0 24 24" width="15" height="15" {...HSS}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
      </button>
      <button type="button" onClick={toggleFs} title={fs ? "Exit fullscreen" : "Fullscreen"} className={tiny}>
        {fs
          ? <svg viewBox="0 0 24 24" width="15" height="15" {...HSS}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
          : <svg viewBox="0 0 24 24" width="15" height="15" {...HSS}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>}
      </button>
    </div>
  );
}

function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

// Notifications bell: unread badge + click-to-open dropdown of recent
// notifications (mark one / mark all read) with a "View all" link to the page.
function NotificationsBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const { data } = useQuery({
    queryKey: ["notifications-bell"],
    queryFn: () => api.get("/messaging/notifications", { params: { page_size: 8 } }).then((r) => r.data),
    refetchInterval: 30000,
  });
  const items = data?.items || [];
  const unread = items.filter((n) => !n.read);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications-bell"] });
  const markRead = useMutation({ mutationFn: (id) => api.post(`/messaging/notifications/${id}/read`), onSuccess: invalidate });
  const markAll = useMutation({ mutationFn: () => Promise.all(unread.map((n) => api.post(`/messaging/notifications/${n.id}/read`))), onSuccess: invalidate });

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`relative p-2 rounded-md transition ${open ? "text-foreground bg-hover" : "text-muted hover:text-foreground hover:bg-hover"}`}
        aria-label="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon icon="heroicons-outline:bell" className="text-lg" />
        {unread.length > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 rounded-lg border border-card-border bg-card shadow-2xl z-[60] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-card-border">
            <span className="text-sm font-semibold text-foreground">Notifications{unread.length > 0 ? ` · ${unread.length}` : ""}</span>
            {unread.length > 0 && (
              <button onClick={() => markAll.mutate()} disabled={markAll.isPending} className="text-xs text-blue-400 hover:underline disabled:opacity-50">Mark all read</button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted">
              <Icon icon="heroicons-outline:bell-slash" className="text-2xl mx-auto mb-2" />No notifications
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-card-border">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => { if (!n.read) markRead.mutate(n.id); }}
                    className={`w-full text-left px-4 py-3 hover:bg-hover transition ${n.read ? "" : "bg-hover/40"}`}
                  >
                    <div className="flex items-start gap-2">
                      {n.read ? <span className="w-2 shrink-0" /> : <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">{n.title}</div>
                        {n.body && <div className="text-xs text-muted mt-0.5 line-clamp-2">{n.body}</div>}
                        <div className="text-[11px] text-muted mt-1">{fmtTs(n.ts)}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link href="/notifications" onClick={() => setOpen(false)} className="block px-4 py-2.5 text-center text-sm text-blue-400 hover:bg-hover border-t border-card-border">
            View all
          </Link>
        </div>
      )}
    </div>
  );
}

// Account menu: Account link, theme toggle, avatar add/change/remove, Sign out.
function AccountMenu() {
  const { user, logout, reload } = useAuth();
  const { theme, toggle } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const [openUser, setOpenUser] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const userRef = useRef(null);
  const displayName = user?.full_name || user?.email;

  // Close the account menu on an outside click or Escape.
  useEffect(() => {
    if (!openUser) return;
    function onDoc(e) {
      if (userRef.current && !userRef.current.contains(e.target)) setOpenUser(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpenUser(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [openUser]);

  // Close it on navigation.
  useEffect(() => setOpenUser(false), [pathname]);

  async function onPickAvatar(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.post("/auth/me/avatar", fd);
      await reload();
      toast.success("Photo updated");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    setUploading(true);
    try {
      await api.delete("/auth/me/avatar");
      await reload();
      toast.success("Photo removed");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="relative" ref={userRef}>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickAvatar} />
      <button
        onClick={() => setOpenUser((o) => !o)}
        className="flex items-center gap-2 pl-1.5 pr-1"
        aria-haspopup="menu"
        aria-expanded={openUser}
      >
        <Avatar src={user?.avatar_url} name={displayName} size={28} />
        <Icon
          icon="heroicons-outline:chevron-down"
          className={`text-sm text-muted shrink-0 transition ${openUser ? "rotate-180" : ""}`}
        />
      </button>
      {openUser && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg border border-card-border bg-card shadow-2xl py-1 z-[60]">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-card-border">
            <Avatar src={user?.avatar_url} name={displayName} size={36} />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-foreground truncate">{displayName}</div>
              <div className="text-[11px] text-muted truncate">{user?.email}</div>
            </div>
          </div>
          <Link
            href="/account"
            onClick={() => setOpenUser(false)}
            className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-muted hover:text-foreground hover:bg-hover transition"
          >
            <Icon icon="heroicons-outline:user-circle" className="text-base shrink-0" />
            Account
          </Link>
          <button
            onClick={toggle}
            className="w-full flex items-center justify-between gap-2.5 px-4 py-2 text-[13px] text-muted hover:text-foreground hover:bg-hover transition"
          >
            <span className="flex items-center gap-2.5">
              <Icon
                icon={theme === "dark" ? "heroicons-outline:sun" : "heroicons-outline:moon"}
                className="text-base shrink-0"
              />
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
            <span className={`relative h-4 w-7 rounded-full transition ${theme === "dark" ? "bg-foreground/30" : "bg-hover"}`}>
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-foreground transition-all ${theme === "dark" ? "left-3.5" : "left-0.5"}`} />
            </span>
          </button>
          <button
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-muted hover:text-foreground hover:bg-hover transition disabled:opacity-50"
          >
            <Icon icon="heroicons-outline:camera" className="text-base shrink-0" />
            {uploading ? "Uploading…" : user?.avatar_url ? "Change photo" : "Add photo"}
          </button>
          {user?.avatar_url && (
            <button
              disabled={uploading}
              onClick={removeAvatar}
              className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-muted hover:text-foreground hover:bg-hover transition disabled:opacity-50"
            >
              <Icon icon="heroicons-outline:trash" className="text-base shrink-0" />
              Remove photo
            </button>
          )}
          <div className="my-1 border-t border-card-border" />
          <button
            onClick={async () => {
              await logout();
              router.replace("/login");
            }}
            className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-red-500 hover:bg-hover transition"
          >
            <Icon icon="heroicons-outline:arrow-right-on-rectangle" className="text-base shrink-0" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// The floating dock itself. `home` shows the HOME status strip alongside the
// controls (clock/lock/fullscreen). Rendered fixed, top-right, above page chrome.
export default function GlobalNavDock({ home = false }) {
  return (
    <div className="fixed right-3 top-2.5 z-50 flex items-center gap-1 rounded-[12px] border border-[rgba(150,180,245,.18)] bg-[rgba(10,18,40,.72)] px-2 py-1.5 shadow-[0_6px_24px_rgba(0,0,0,.35)] backdrop-blur">
      {/* ⊞ MENU navigator launcher — jump to any section from any screen. */}
      <MenuNavigator />
      {home && <HomeStatusStrip />}
      <button
        onClick={() => window.dispatchEvent(new Event("palette:open"))}
        className="hidden sm:flex items-center gap-2 rounded-md border border-card-border text-muted hover:text-foreground hover:bg-hover transition px-2.5 py-1.5"
        aria-label="Search"
        title="Search (⌘K)"
      >
        <Icon icon="heroicons-outline:magnifying-glass" className="text-base" />
        <kbd className="text-[10px] border border-card-border rounded px-1 py-0.5">⌘K</kbd>
      </button>
      <NotificationsBell />
      <AccountMenu />
    </div>
  );
}
