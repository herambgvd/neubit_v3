/**
 * The viewer, and the one thing the category was added for: a console shows ITS
 * dashboards.
 *
 * The filter has to reach the API as a query. A client-side slice would mean
 * every viewer's browser received every other console's registrations first, and
 * the "surveillance dashboards" heading would sit above a list assembled from a
 * response that was never scoped.
 *
 * The pinned category also has to WIN over `?c=`: a page that IS one console's
 * dashboards must not be talked into showing another's by a hand-edited URL.
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import DashboardsViewer from "./DashboardsViewer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true }) }));

let query = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}));

// The embed is a live iframe against a minted token; this surface's job is
// choosing WHICH dashboard, so the frame is stubbed to its name.
vi.mock("./EmbedView", () => ({
  default: ({ name }: { name: string }) => <div data-testid="embed">{name}</div>,
}));

const CAM = {
  id: "d2",
  name: "Camera uptime",
  description: null,
  category: "vms",
  workspace_ref: "ws1",
  dashboard_ref: "db2",
  scope: {},
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({ "GET /dashforge/dashboards": { items: [CAM], total: 1 }, ...over });
  return stub;
}

beforeEach(() => {
  query = "";
  stubAll();
});

describe("a pinned console", () => {
  it("asks the API for its own category rather than filtering in the browser", async () => {
    renderWithProviders(<DashboardsViewer category="vms" />);

    await waitFor(() => expect(stub.matching("GET /dashforge/dashboards")).not.toHaveLength(0));
    expect(stub.matching("GET /dashforge/dashboards")[0]!.params?.category).toBe("vms");
    expect(await screen.findByTestId("embed")).toHaveTextContent("Camera uptime");
  });

  it("ignores a ?c= that names a different console", async () => {
    query = "c=building";
    renderWithProviders(<DashboardsViewer category="vms" />);

    await waitFor(() => expect(stub.matching("GET /dashforge/dashboards")).not.toHaveLength(0));
    expect(stub.matching("GET /dashforge/dashboards")[0]!.params?.category).toBe("vms");
  });

  it("says the category is empty rather than that nothing is registered", async () => {
    // A surveillance operator seeing "no dashboards registered" would go looking
    // for a platform-wide problem; what is true is that none are filed here.
    stubAll({ "GET /dashforge/dashboards": { items: [], total: 0 } });
    renderWithProviders(<DashboardsViewer category="vms" />);

    expect(await screen.findByText(/No Surveillance dashboards/i)).toBeInTheDocument();
  });

  it("reports a failed load instead of an empty console", async () => {
    stubAll({ "GET /dashforge/dashboards": () => httpError(503, "registry unreachable") });
    renderWithProviders(<DashboardsViewer category="vms" />);

    expect(await screen.findByText(/registry unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No Surveillance dashboards/i)).toBeNull();
  });
});

describe("the unpinned surface", () => {
  it("reads ?c= and offers the other categories as tabs", async () => {
    query = "c=vms";
    renderWithProviders(<DashboardsViewer />);

    await waitFor(() => expect(stub.matching("GET /dashforge/dashboards")).not.toHaveLength(0));
    expect(stub.matching("GET /dashforge/dashboards")[0]!.params?.category).toBe("vms");
    expect(screen.getByRole("button", { name: /Building Intelligence/ })).toBeInTheDocument();
  });

  it("asks for everything when no category is named", async () => {
    renderWithProviders(<DashboardsViewer />);

    await waitFor(() => expect(stub.matching("GET /dashforge/dashboards")).not.toHaveLength(0));
    expect(stub.matching("GET /dashforge/dashboards")[0]!.params?.category).toBeUndefined();
  });

  it("ignores a ?c= that is not a category at all", async () => {
    // An unknown slug reaches the API as a 422; asking for nothing and showing
    // every dashboard is the honest fallback for a mistyped link.
    query = "c=cctv";
    renderWithProviders(<DashboardsViewer />);

    await waitFor(() => expect(stub.matching("GET /dashforge/dashboards")).not.toHaveLength(0));
    expect(stub.matching("GET /dashforge/dashboards")[0]!.params?.category).toBeUndefined();
  });
});
