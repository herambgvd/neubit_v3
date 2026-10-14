import Login from "@/features/core/auth/Login";

// Drawn in the theme this browser picked, like every console page: the boot
// script in app/layout.tsx has set it on <html> before the first paint.
export default function LoginPage() {
  return <Login />;
}
