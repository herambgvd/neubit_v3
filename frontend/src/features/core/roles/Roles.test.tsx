/**
 * A role IS the permission set every user inherits, so the expensive mistakes are
 * editing a built-in role, deleting one without a confirm, and sending a body the
 * roles endpoint does not accept.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";
import type { RoleOut } from "../types";

import RolesPage from "./Roles";

let perms: string[] = ["*"];

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "me" },
    can: (p: string) => perms.includes("*") || perms.includes(p),
    hasModule: () => true,
  }),
}));

const role = (over: Partial<RoleOut> = {}): RoleOut => ({
  id: "r1",
  name: "Operator",
  description: "Watches cameras",
  permissions: ["camera.view"],
  is_system: false,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

const OPERATOR = role();
const ADMIN = role({ id: "r0", name: "Administrator", permissions: ["*"], is_system: true });

const CATALOG = {
  groups: {
    Cameras: [
      { key: "camera.view", label: "View cameras" },
      { key: "camera.manage", label: "Manage cameras" },
    ],
  },
};

let stub: ApiStub;

beforeEach(() => {
  perms = ["*"];
  stub = stubApi({
    "GET /auth/roles": paged([OPERATOR, ADMIN]),
    "GET /auth/permissions": CATALOG,
    "POST /auth/roles": OPERATOR,
    "PATCH /auth/roles/*": OPERATOR,
    "DELETE /auth/roles/*": {},
  });
});

describe("permission gating", () => {
  it("offers no create or edit affordance without role.manage", async () => {
    perms = ["role.view"];

    renderWithProviders(<RolesPage />);
    await screen.findAllByText("Operator");

    expect(screen.queryByRole("button", { name: /new role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete role/i })).not.toBeInTheDocument();
  });
});

describe("a failed load", () => {
  it("reports the failure instead of claiming there are no roles", async () => {
    stub.set({ "GET /auth/roles": () => httpError(500, "Role store unreachable") });

    renderWithProviders(<RolesPage />);

    expect(await screen.findByText("Role store unreachable")).toBeInTheDocument();
    expect(screen.queryByText(/no roles yet/i)).not.toBeInTheDocument();
  });
});

describe("which row is open", () => {
  it("opens the first role when the operator has chosen none", async () => {
    renderWithProviders(<RolesPage />);

    expect(await screen.findAllByText("Watches cameras")).not.toHaveLength(0);
  });

  it("keeps an explicit choice across a refetch of the list", async () => {
    const { client } = renderWithProviders(<RolesPage />);
    await screen.findAllByText("Operator");

    await userEvent.click(screen.getAllByText("Administrator")[0]);
    await client.invalidateQueries({ queryKey: ["roles"] });
    await waitFor(() => expect(stub.matching("GET /auth/roles").length).toBeGreaterThan(1));

    expect(screen.getAllByText("Administrator").length).toBeGreaterThan(1);
  });
});

describe("a built-in role", () => {
  // The Administrator role is the way back into a locked-out deployment.
  it("cannot be deleted", async () => {
    renderWithProviders(<RolesPage />);
    await userEvent.click((await screen.findAllByText("Administrator"))[0]);

    expect(screen.queryByRole("button", { name: /delete role/i })).not.toBeInTheDocument();
  });

  it("opens read-only, with no way to save a change to it", async () => {
    renderWithProviders(<RolesPage />);
    await userEvent.click((await screen.findAllByText("Administrator"))[0]);
    await userEvent.click(screen.getByRole("button", { name: /view/i }));

    expect(await screen.findByText(/system roles are built in/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
  });
});

describe("deleting a role", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<RolesPage />);
    await screen.findAllByText("Operator");

    await userEvent.click(screen.getByRole("button", { name: /delete role/i }));

    expect(await screen.findByText(/this can’t be undone/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /auth/roles/*")).toHaveLength(0);

    // The pane's Delete action and the dialog's confirm share a name; the
    // dialog appended the second one.
    await userEvent.click(screen.getAllByRole("button", { name: /^delete role$/i }).at(-1)!);
    await waitFor(() => expect(stub.matching("DELETE /auth/roles/*")).toHaveLength(1));
    expect(stub.matching("DELETE /auth/roles/*")[0].url).toBe("/auth/roles/r1");
  });
});

describe("the role form", () => {
  it("refuses to create a nameless role before the network sees it", async () => {
    renderWithProviders(<RolesPage />);
    await screen.findAllByText("Operator");
    await userEvent.click(screen.getByRole("button", { name: /new role/i }));

    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/role name is required/i)).toBeInTheDocument();
    expect(stub.matching("POST /auth/roles")).toHaveLength(0);
  });

  it("sends the name, description and the permission keys that were ticked", async () => {
    renderWithProviders(<RolesPage />);
    await screen.findAllByText("Operator");
    await userEvent.click(screen.getByRole("button", { name: /new role/i }));

    await userEvent.type(
      screen.getByPlaceholderText("Enter role name (e.g. Operator)"),
      "Night shift"
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /view cameras/i }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(stub.matching("POST /auth/roles")).toHaveLength(1));
    expect(stub.body("POST /auth/roles")).toEqual({
      name: "Night shift",
      description: "",
      permissions: ["camera.view"],
    });
  });

  it("edits through a PATCH that carries no id in its body", async () => {
    renderWithProviders(<RolesPage />);
    await screen.findAllByText("Operator");
    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    const name = await screen.findByPlaceholderText("Enter role name (e.g. Operator)");
    await userEvent.clear(name);
    await userEvent.type(name, "Senior operator");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(stub.matching("PATCH /auth/roles/*")).toHaveLength(1));
    expect(stub.matching("PATCH /auth/roles/*")[0].url).toBe("/auth/roles/r1");
    expect(Object.keys(stub.body("PATCH /auth/roles/*") || {}).sort()).toEqual([
      "description",
      "name",
      "permissions",
    ]);
  });
});
