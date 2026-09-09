/**
 * Configurations → Dashboards: the CRUD console a registration is made on.
 *
 * The behaviours worth guarding are the ones that quietly file a dashboard where
 * nobody can see it, or destroy something an operator did not mean to touch:
 *
 *  • a registration carries its CATEGORY to the API — that value alone decides
 *    which console lists it, and a form that dropped it would file everything
 *    under the default while the operator watched themself pick "Surveillance";
 *  • an edit keeps the category it was given;
 *  • removal is confirmed, and the confirmation says the dashboard itself is not
 *    deleted — "remove dashboard" otherwise reads as destroying it in DashForge;
 *  • without `dashforge.manage` there is no create, edit or delete affordance at
 *    all, rather than buttons that 403.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import DashboardsManager from "./DashboardsManager";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

let canManage = true;
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => (p === "dashforge.manage" ? canManage : true) }),
}));

const ENERGY = {
  id: "d1",
  name: "Energy overview",
  description: "kWh by meter",
  category: "building",
  workspace_ref: "ws1",
  dashboard_ref: "db1",
  scope: { site_id: "42" },
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const CAMERAS = { ...ENERGY, id: "d2", name: "Camera uptime", category: "vms", dashboard_ref: "db2", scope: {} };

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /dashforge/dashboards": { items: [ENERGY, CAMERAS], total: 2 },
    "POST /dashforge/dashboards": ENERGY,
    "PATCH /dashforge/dashboards/*": ENERGY,
    "DELETE /dashforge/dashboards/*": {},
    ...over,
  });
  return stub;
}

beforeEach(() => {
  canManage = true;
  stubAll();
});

describe("the list", () => {
  it("shows every console's dashboards, each labelled with the one that shows it", async () => {
    renderWithProviders(<DashboardsManager />);

    expect(await screen.findAllByText("Energy overview")).not.toHaveLength(0);
    expect(screen.getByText("Camera uptime")).toBeInTheDocument();
    expect(screen.getAllByText(/Building Intelligence/).length).toBeGreaterThan(0);
  });

  it("narrows to one category when its filter is picked", async () => {
    renderWithProviders(<DashboardsManager />);
    await screen.findAllByText("Energy overview");

    await userEvent.click(screen.getByRole("button", { name: /^Video 1$/ }));

    expect(screen.getAllByText("Camera uptime")).not.toHaveLength(0);
    expect(screen.queryByText("Energy overview")).toBeNull();
  });

  it("reports a failed load rather than an empty estate", async () => {
    // "No dashboards registered" tells an operator to go and register one. "We
    // could not read them" means the ones they have may be fine.
    stubAll({ "GET /dashforge/dashboards": () => httpError(503, "registry unreachable") });
    renderWithProviders(<DashboardsManager />);

    expect(await screen.findByText(/registry unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no dashboards registered/i)).toBeNull();
  });
});

describe("registering", () => {
  it("sends the category the operator chose, not the default", async () => {
    renderWithProviders(<DashboardsManager />);
    await screen.findAllByText("Energy overview");

    await userEvent.click(screen.getByRole("button", { name: /new dashboard/i }));
    await userEvent.type(await screen.findByLabelText(/^name/i), "Door alarms");
    await userEvent.click(screen.getByRole("button", { name: /category/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Access Control" }));
    await userEvent.type(screen.getByLabelText(/workspace id/i), "ws9");
    await userEvent.type(screen.getByLabelText(/dashboard id/i), "db9");
    await userEvent.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => expect(stub.matching("POST /dashforge/dashboards")).toHaveLength(1));
    const body = stub.body("POST /dashforge/dashboards")!;
    expect(body.category).toBe("access");
    expect(body.name).toBe("Door alarms");
  });

  it("opens the form on the category being filtered, so the filing matches where they stood", async () => {
    renderWithProviders(<DashboardsManager />);
    await screen.findAllByText("Energy overview");

    await userEvent.click(screen.getByRole("button", { name: /^Video 1$/ }));
    await userEvent.click(screen.getByRole("button", { name: /new dashboard/i }));
    await userEvent.type(await screen.findByLabelText(/^name/i), "Wall health");
    await userEvent.type(screen.getByLabelText(/workspace id/i), "ws9");
    await userEvent.type(screen.getByLabelText(/dashboard id/i), "db9");
    await userEvent.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => expect(stub.matching("POST /dashforge/dashboards")).toHaveLength(1));
    expect(stub.body("POST /dashforge/dashboards")!.category).toBe("vms");
  });
});

describe("editing", () => {
  it("loads the row's own category and sends it back unchanged", async () => {
    // An edit of the NAME must not relocate the dashboard to another console.
    renderWithProviders(<DashboardsManager />);
    await screen.findAllByText("Energy overview");

    await userEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]!);
    const name = await screen.findByLabelText(/^name/i);
    await userEvent.clear(name);
    await userEvent.type(name, "Energy overview v2");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(stub.matching("PATCH /dashforge/dashboards/d1")).toHaveLength(1));
    const body = stub.body("PATCH /dashforge/dashboards/d1")!;
    expect(body.category).toBe("building");
    expect(body.name).toBe("Energy overview v2");
  });
});

describe("removing", () => {
  it("asks first, and says the dashboard itself is not deleted", async () => {
    renderWithProviders(<DashboardsManager />);
    await screen.findAllByText("Energy overview");

    await userEvent.click(screen.getAllByRole("button", { name: /^remove$/i })[0]!);

    expect(await screen.findByText(/stays in DashForge and is not deleted/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /dashforge/dashboards/d1")).toHaveLength(0);

    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(stub.matching("DELETE /dashforge/dashboards/d1")).toHaveLength(1));
  });
});

describe("without dashforge.manage", () => {
  it("offers no way to register, edit or remove", async () => {
    canManage = false;
    renderWithProviders(<DashboardsManager />);
    await screen.findAllByText("Energy overview");

    expect(screen.queryByRole("button", { name: /new dashboard/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
  });
});
