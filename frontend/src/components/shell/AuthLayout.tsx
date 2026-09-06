// Auth pages (setup, forgot-password) render their own full-screen AuthShell,
// so this layout is a pass-through — no extra centering/background wrapper.
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children?: ReactNode }) {
  return children;
}
