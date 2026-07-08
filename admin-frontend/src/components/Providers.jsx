"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";

import { ThemeProvider, useTheme } from "@/components/theme";

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" richColors closeButton />;
}

// App-wide client providers for the admin console: theme + TanStack Query + sonner toasts.
export default function Providers({ children }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
        },
      })
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        {children}
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
