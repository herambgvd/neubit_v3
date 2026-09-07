/**
 * The first-run wizard creates the ONLY account that exists on a fresh
 * deployment — a wrong body here leaves nobody able to sign in. These pin what
 * it sends, that a mismatched confirmation never reaches the network, and that a
 * deployment which is already set up cannot be walked through it a second time.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { stubApi, type ApiStub } from "@/test/apiStub";

import SetupPage from "./Setup";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
}));

let stub: ApiStub;

beforeEach(() => {
  tokens.clear();
  replace.mockClear();
  stub = stubApi({
    "GET /auth/setup-status": { needs_setup: true },
    "POST /auth/setup": { access_token: "first-admin-token" },
    "GET /auth/me": { id: "u1", email: "admin@acme.com", role: { permissions: ["*"] } },
    "GET /features": { modules: [], license_state: "active" },
  });
});

const renderSetup = () =>
  render(
    <AuthProvider>
      <SetupPage />
    </AuthProvider>
  );

async function fill({ name = "Jane Doe", email = "admin@acme.com", password = "hunter22", confirm = "hunter22" } = {}) {
  await screen.findByLabelText("Full name");
  if (name) await userEvent.type(screen.getByLabelText("Full name"), name);
  if (email) await userEvent.type(screen.getByLabelText("Work email"), email);
  if (password) await userEvent.type(screen.getByLabelText("Password"), password);
  if (confirm) await userEvent.type(screen.getByLabelText("Confirm password"), confirm);
}

describe("creating the first administrator", () => {
  it("sends exactly the three fields the setup endpoint accepts", async () => {
    renderSetup();
    await fill();

    await userEvent.click(screen.getByRole("button", { name: /create admin/i }));

    await waitFor(() => expect(stub.matching("POST /auth/setup")).toHaveLength(1));
    // `confirm` is a UI-only field; sending it would 422 the request.
    expect(stub.body("POST /auth/setup")).toEqual({
      email: "admin@acme.com",
      password: "hunter22",
      full_name: "Jane Doe",
    });
  });

  it("sends a null name rather than an empty one when the field is left blank", async () => {
    renderSetup();
    await fill({ name: "" });

    await userEvent.click(screen.getByRole("button", { name: /create admin/i }));

    await waitFor(() => expect(stub.matching("POST /auth/setup")).toHaveLength(1));
    expect(stub.body("POST /auth/setup")?.full_name).toBeNull();
  });

  it("signs the new administrator straight in with the token it got back", async () => {
    renderSetup();
    await fill();

    await userEvent.click(screen.getByRole("button", { name: /create admin/i }));

    await waitFor(() => expect(tokens.access).toBe("first-admin-token"));
    expect(replace).toHaveBeenCalledWith("/");
  });
});

describe("password confirmation", () => {
  it("blocks the request entirely when the two passwords disagree", async () => {
    renderSetup();
    await fill({ confirm: "hunter23" });

    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /create admin/i }));

    expect(stub.matching("POST /auth/setup")).toHaveLength(0);
  });
});

describe("a deployment that is already set up", () => {
  it("shows no wizard at all and sends the visitor to sign in", async () => {
    stub.set({ "GET /auth/setup-status": { needs_setup: false } });

    renderSetup();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByLabelText("Work email")).not.toBeInTheDocument();
  });
});
