// Auth pages (setup, forgot-password) render their own full-screen shell, so
// this layout adds nothing: no centering, no background, and no theme of its
// own — they are drawn in the theme this browser picked, like the console.
import type { ReactNode } from "react";

export default function AuthLayout({ children }: Readonly<{ children?: ReactNode }>) {
  return <>{children}</>;
}
