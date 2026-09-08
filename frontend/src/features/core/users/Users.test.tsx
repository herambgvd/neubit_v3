/**
 * The Users console is the one screen that can lock an organisation out of its
 * own deployment, so what it pins is: who may act, what the confirm gate costs,
 * what the PATCH body contains, and that a failed load is never dressed up as an
 * empty directory.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";
import type { RoleOut, UserOut } from "../types";

import UsersPage from "./Users";

/** The signed-in operator's permissions; each test sets them before rendering. */
let perms: string[] = ["*"];
const ME = { id: "me", email: "admin@acme.com" };

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: ME,
    can: (p: string) => perms.includes("*") || perms.includes(p),
    hasModule: () => true,
  }),
}));

const OPERATOR: RoleOut = {
  id: "r1",
  name: "Operator",
  description: "Console operator",
  permissions: ["camera.view"],
  is_system: false,
  created_at: "2026-01-01T00:00:00Z",
};

function makeUser(over: Partial<UserOut> = {}): UserOut {
  return {
    id: "u1",
    email: "ada@acme.com",
    full_name: "Ada Lovelace",
    role: OPERATOR,
    is_superadmin: false,
    is_active: true,
    email_verified: true,
    created_at: "2026-01-01T00:00:00Z",
    last_login_at: null,
    avatar_url: null,
    preferences: {},
    totp_enabled: false,
    failed_login_count: 0,
    locked_until: null,
    locked: false,
    password_changed_at: null,
    active_sessions: 0,
    site_ids: [],
    ...over,
  };
}

const ADA = makeUser();
const GRACE = makeUser({ id: "u2", email: "grace@acme.com", full_name: "Grace Hopper" });

let stub: ApiStub;

beforeEach(() => {
  perms = ["*"];
  stub = stubApi({
    "GET /auth/users": paged([ADA, GRACE]),
    "GET /auth/roles": paged([OPERATOR]),
    "GET /sites": paged([]),
    "GET /security/policy": { session_idle_minutes: 30 },
    "POST /auth/users": ADA,
    "PATCH /auth/users/*": ADA,
    "DELETE /auth/users/*": {},
  });
});

describe("permission gating", () => {
  it("offers no way to create or delete a user without user.manage", async () => {
    perms = ["user.view"];

    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: /new user/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete user/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /import csv/i })).not.toBeInTheDocument();
  });

  it("offers both to an operator who has it", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");

    expect(screen.getByRole("button", { name: /new user/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete user/i })).toBeInTheDocument();
  });

  // Deleting yourself is the one action nobody can undo from the console.
  it("never offers to delete the signed-in operator's own account", async () => {
    stub.set({ "GET /auth/users": paged([makeUser({ id: "me", email: "admin@acme.com", full_name: "Admin" })]) });

    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Admin");

    expect(screen.queryByRole("button", { name: /delete user/i })).not.toBeInTheDocument();
  });
});

describe("a failed load", () => {
  it("reports the failure instead of claiming the directory is empty", async () => {
    stub.set({ "GET /auth/users": () => httpError(503, "Directory service unavailable") });

    renderWithProviders(<UsersPage />);

    expect(await screen.findByText("Directory service unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/no users yet/i)).not.toBeInTheDocument();
  });
});

describe("which row is open", () => {
  it("opens the first user when the operator has chosen none", async () => {
    renderWithProviders(<UsersPage />);

    expect(await screen.findAllByText("ada@acme.com")).not.toHaveLength(0);
  });

  it("keeps an explicit choice across a refetch of the list", async () => {
    const { client } = renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");

    await userEvent.click(screen.getAllByText("Grace Hopper")[0]);
    expect(await screen.findAllByText("grace@acme.com")).not.toHaveLength(0);

    await client.invalidateQueries({ queryKey: ["users"] });
    await waitFor(() => expect(stub.matching("GET /auth/users").length).toBeGreaterThan(1));

    // The old effect-based sync snapped the pane back to the first row here.
    expect(screen.getAllByText("grace@acme.com").length).toBeGreaterThan(0);
  });
});

describe("deleting a user", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: /delete user/i }));

    expect(await screen.findByText(/permanently deletes/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /auth/users/*")).toHaveLength(0);
  });

  it("re-authorises with the admin's own password rather than the target's id alone", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /delete user/i }));

    await screen.findByText(/permanently deletes/i);
    await userEvent.type(
      screen.getByPlaceholderText("Enter your account password"),
      "my-own-password"
    );
    // Two controls share the name: the pane's Delete action and the dialog's
    // confirm button, which is the one the dialog appended.
    await userEvent.click(screen.getAllByRole("button", { name: "Delete user" }).at(-1)!);

    await waitFor(() => expect(stub.matching("DELETE /auth/users/*")).toHaveLength(1));
    expect(stub.matching("DELETE /auth/users/*")[0].url).toBe("/auth/users/u1");
    expect(stub.body("DELETE /auth/users/*")).toEqual({ password: "my-own-password" });
  });

  it("cannot be confirmed until the password is supplied", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /delete user/i }));

    await screen.findByText(/permanently deletes/i);
    expect(screen.getAllByRole("button", { name: "Delete user" }).at(-1)).toBeDisabled();
  });
});

describe("the create form", () => {
  it("refuses to post an incomplete account and names each missing field", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /new user/i }));

    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/full name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/email is required/i)).toBeInTheDocument();
    expect(screen.getByText(/pick a role for this user/i)).toBeInTheDocument();
    expect(stub.matching("POST /auth/users")).toHaveLength(0);
  });

  it("holds a password to the backend's own policy before sending it", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /new user/i }));
    await userEvent.type(screen.getByPlaceholderText("Enter a password"), "short1");

    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(stub.matching("POST /auth/users")).toHaveLength(0);
  });

  it("sends the whole account — role and site scope included — in one body", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /new user/i }));

    await userEvent.type(screen.getByPlaceholderText("Enter full name"), "Grace Hopper");
    await userEvent.type(screen.getByPlaceholderText("Enter email address"), "grace@acme.com");
    await userEvent.type(screen.getByPlaceholderText("Enter a password"), "hunter22");
    // Named "Role" now, not by its placeholder: the picker's trigger is a button
    // and carries its field label as an aria-label (kit.Select), so a screen
    // reader announces what it sets rather than the current value.
    await userEvent.click(screen.getByRole("button", { name: /^role$/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Operator" }));

    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(stub.matching("POST /auth/users")).toHaveLength(1));
    expect(stub.body("POST /auth/users")).toEqual({
      full_name: "Grace Hopper",
      email: "grace@acme.com",
      password: "hunter22",
      role_id: "r1",
      send_invite: true,
      site_ids: [],
    });
  });
});

describe("the edit form", () => {
  it("omits the password entirely when it is left blank, rather than blanking it", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    const name = await screen.findByPlaceholderText("Enter full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Ada King");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(stub.matching("PATCH /auth/users/*")).toHaveLength(1));
    const body = stub.body("PATCH /auth/users/*") || {};
    expect(body).not.toHaveProperty("password");
    expect(body.full_name).toBe("Ada King");
  });

  it("keeps the dialog's own bookkeeping out of the PATCH body", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(stub.matching("PATCH /auth/users/*")).toHaveLength(1));
    const body = stub.body("PATCH /auth/users/*") || {};
    // `close` and `id` are UI-only; the backend rejects unknown fields.
    expect(body).not.toHaveProperty("close");
    expect(body).not.toHaveProperty("id");
    expect(Object.keys(body).sort()).toEqual(["email", "full_name", "is_active", "role_id", "site_ids"]);
  });
});

describe("the security posture panel", () => {
  it("shows the recovery actions only to an operator who may use them", async () => {
    perms = ["user.view"];
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: /force sign-out/i })).not.toBeInTheDocument();
  });

  it("signs a user out of every session through the admin action endpoint", async () => {
    stub.set({ "GET /auth/users": paged([makeUser({ active_sessions: 2 })]), "POST /auth/users/*": {} });
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: /force sign-out/i }));

    await waitFor(() =>
      expect(stub.matching("POST /auth/users/*").map((c) => c.url)).toContain(
        "/auth/users/u1/revoke-sessions"
      )
    );
  });
});

describe("the list", () => {
  it("filters by the search box without going back to the server", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findAllByText("Ada Lovelace");
    const before = stub.matching("GET /auth/users").length;

    await userEvent.type(screen.getByPlaceholderText(/search users/i), "grace");

    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument());
    expect(screen.getAllByText("Grace Hopper").length).toBeGreaterThan(0);
    expect(stub.matching("GET /auth/users")).toHaveLength(before);
  });
});
