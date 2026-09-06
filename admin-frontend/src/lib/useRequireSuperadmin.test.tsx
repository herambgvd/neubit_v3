import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { User } from "@/lib/types";
import { useRequireSuperadmin } from "@/lib/useRequireSuperadmin";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const superadmin = { id: "u1", email: "root@neubit", is_superadmin: true } as User;
const tenantUser = { id: "u2", email: "ops@acme", is_superadmin: false } as User;

beforeEach(() => {
  replace.mockClear();
});

// The server's require_superadmin stays authoritative; this gate decides what the
// browser is allowed to render, so "a signed-in NON-superadmin is denied" is the
// case that matters — not merely "signed out is denied".
describe("useRequireSuperadmin", () => {
  it("admits a super-admin", async () => {
    vi.spyOn(adminApi, "bootstrap").mockResolvedValue(superadmin);

    const { result } = renderHook(() => useRequireSuperadmin(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(replace).not.toHaveBeenCalled();
  });

  it("denies a signed-in user who is not a super-admin", async () => {
    vi.spyOn(adminApi, "bootstrap").mockResolvedValue(tenantUser);

    const { result } = renderHook(() => useRequireSuperadmin(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("denies when there is no session at all", async () => {
    vi.spyOn(adminApi, "bootstrap").mockResolvedValue(null);

    const { result } = renderHook(() => useRequireSuperadmin(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("does not admit anyone while the session is still loading", async () => {
    vi.spyOn(adminApi, "bootstrap").mockImplementation(
      () => new Promise(() => {}) // never settles
    );

    const { result } = renderHook(() => useRequireSuperadmin(), { wrapper });

    expect(result.current.status).toBe("loading");
    expect(replace).not.toHaveBeenCalled();
  });
});
