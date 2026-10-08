"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

// SIDE EFFECT, and it must run before the first <Icon> mounts: it registers the
// offline icon bundle. Without it @iconify/react fetches every glyph from
// api.iconify.design at runtime, so on a restricted or air-gapped network the
// whole console renders with no icons at all and says nothing. See lib/icons/.
import "@/lib/icons";

import { AppearanceProvider } from "@/lib/appearance";
import { AuthProvider } from "@/lib/auth";
import { useToastInset } from "@/lib/toastInset";
import { ThemeProvider } from "@/components/theme";
import TitleSync from "@/components/TitleSync";

// Sonner's own figures: its viewport offsets (desktop, phone) and stack gap.
const TOAST_OFFSET = 24;
const TOAST_OFFSET_MOBILE = 16;
const TOAST_GAP = 14;

// Dark-only console — the toasts are pinned to match. They sit above whatever
// holds the bottom of the corner (the VMS alarm card), not on top of it.
function ThemedToaster() {
  const inset = useToastInset();
  const lift = inset ? inset + TOAST_GAP : 0;
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      richColors
      closeButton
      offset={{ bottom: TOAST_OFFSET + lift }}
      mobileOffset={{ bottom: TOAST_OFFSET_MOBILE + lift }}
    />
  );
}

// App-wide client providers: theme + TanStack Query + Auth + sonner toasts.
export default function Providers({ children }: Readonly<{ children?: ReactNode }>) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
      })
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <TitleSync />
        {/* Inside AuthProvider: the appearance store adopts the signed-in user's
            saved choice when this device has none, and saves changes back. */}
        <AuthProvider>
          <AppearanceProvider>{children}</AppearanceProvider>
        </AuthProvider>
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
