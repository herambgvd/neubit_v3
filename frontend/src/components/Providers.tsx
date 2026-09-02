"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";

// SIDE EFFECT, and it must run before the first <Icon> mounts: it registers the
// offline icon collections. Without it @iconify/react fetches every glyph from
// api.iconify.design at runtime, so on a restricted or air-gapped network the
// whole console renders with no icons at all and says nothing. See lib/icons.ts.
import "@/lib/icons";

import { AuthProvider } from "@/lib/auth";
// Side-effect import: registers the bundled Iconify icon set so nothing is
// fetched from api.iconify.design at runtime (offline/air-gapped installs).
import "@/lib/icons";
import { ThemeProvider } from "@/components/theme";
import TitleSync from "@/components/TitleSync";

// Dark-only console — the toasts are pinned to match.
function ThemedToaster() {
  return <Toaster theme="dark" position="bottom-right" richColors closeButton />;
}

// App-wide client providers: theme + TanStack Query + Auth + sonner toasts.
export default function Providers({ children }: any) {
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
        <AuthProvider>{children}</AuthProvider>
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
