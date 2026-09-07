/**
 * Smoke-level. Providers is the tree every page mounts under, so the thing worth
 * pinning is that it composes at all — a page's children reach the DOM, the auth
 * provider settles rather than hanging, and the icon registry is imported for
 * side effect (without it an air-gapped install renders no icons and says
 * nothing about it).
 *
 * next/navigation is stubbed because there is no app router outside Next;
 * everything else is the real provider stack, served by a stub axios adapter.
 */
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, tokens } from "@/lib/api";

import Providers from "./Providers";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

function respond(config: InternalAxiosRequestConfig, data: unknown = {}): AxiosResponse {
  return { data, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
}

beforeEach(() => {
  tokens.clear();
  // No refresh cookie: the console boots straight to the signed-out state.
  axios.defaults.adapter = async (config) => respond(config, { access_token: null });
  api.defaults.adapter = async (config) => respond(config, {});
});

describe("Providers", () => {
  it("renders the page it wraps", async () => {
    render(
      <Providers>
        <p>Console body</p>
      </Providers>,
    );

    await waitFor(() => expect(screen.getByText("Console body")).toBeInTheDocument());
  });

  it("settles the session instead of leaving the tree hanging on the boot refresh", async () => {
    const { useAuth } = await import("@/lib/auth");
    function Probe() {
      return <span data-testid="status">{useAuth().status}</span>;
    }

    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anon"));
  });

  it("shares one query client across the tree, so two screens asking for the same thing fetch once", async () => {
    let calls = 0;
    api.defaults.adapter = async (config) => {
      calls += 1;
      return respond(config, { app_name: "NeuBit" });
    };
    const { useQuery } = await import("@tanstack/react-query");
    function Branding({ testId }: { testId: string }) {
      const { data } = useQuery({
        queryKey: ["smoke-branding"],
        queryFn: () => api.get("/branding").then((r) => r.data as { app_name: string }),
      });
      return <span data-testid={testId}>{data?.app_name ?? "-"}</span>;
    }

    render(
      <Providers>
        <Branding testId="a" />
        <Branding testId="b" />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByTestId("a")).toHaveTextContent("NeuBit"));
    expect(screen.getByTestId("b")).toHaveTextContent("NeuBit");
    // /branding is requested once for both consumers — plus TitleSync's own,
    // which uses a different key. What matters is that neither Branding refetched.
    expect(calls).toBeLessThanOrEqual(2);
  });
});
