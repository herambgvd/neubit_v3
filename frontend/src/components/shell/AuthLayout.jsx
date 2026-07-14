// Auth pages (setup, forgot-password) render their own full-screen AuthShell,
// so this layout is a pass-through — no extra centering/background wrapper.
export default function AuthLayout({ children }) {
  return children;
}
