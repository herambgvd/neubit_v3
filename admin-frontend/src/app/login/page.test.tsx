import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi, tokens } from "@/lib/api";
import type { LoginResult, User } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import AdminLoginPage from "./page";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

const result = (over: Partial<LoginResult> = {}): LoginResult => ({
  mfa_required: false,
  mfa_token: null,
  access_token: null,
  refresh_token: null,
  token_type: "bearer",
  enrollment_required: false,
  ...over,
});

beforeEach(() => {
  tokens.clear();
  push.mockClear();
  replace.mockClear();
  vi.spyOn(adminApi, "bootstrap").mockResolvedValue(null);
});

async function signIn() {
  // Exact labels: the eye toggle's aria-label ("Show password") also matches a
  // loose /password/ query.
  await userEvent.type(await screen.findByLabelText("Work email"), "root@neubit");
  await userEvent.type(screen.getByLabelText("Password"), "hunter2");
  await userEvent.click(screen.getByRole("button", { name: /sign in to console/i }));
}

describe("admin login", () => {
  it("keeps the returned access token in memory and goes to the dashboard", async () => {
    vi.spyOn(adminApi, "login").mockResolvedValue(result({ access_token: "at-1" }));

    renderWithProviders(<AdminLoginPage />);
    await signIn();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(tokens.access).toBe("at-1");
    // The refresh token is an httpOnly cookie; nothing here may persist a credential.
    expect(localStorage.length).toBe(0);
  });

  it("switches to the code step when a second factor is required", async () => {
    vi.spyOn(adminApi, "login").mockResolvedValue(
      result({ mfa_required: true, mfa_token: "mfa-1" })
    );
    const loginMfa = vi
      .spyOn(adminApi, "loginMfa")
      .mockResolvedValue(result({ access_token: "at-2" }));

    renderWithProviders(<AdminLoginPage />);
    await signIn();

    await userEvent.type(await screen.findByLabelText("Authentication code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));

    await waitFor(() => expect(loginMfa).toHaveBeenCalledWith("mfa-1", "123456"));
    expect(tokens.access).toBe("at-2");
  });

  // A challenge with no token cannot be answered. Showing the password form again
  // would read as "wrong password"; say what actually happened instead.
  it("surfaces an MFA challenge that arrives without a token", async () => {
    vi.spyOn(adminApi, "login").mockResolvedValue(
      result({ mfa_required: true, mfa_token: null })
    );

    renderWithProviders(<AdminLoginPage />);
    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/challenge token/i);
    expect(screen.queryByLabelText(/authentication code/i)).not.toBeInTheDocument();
  });

  it("refuses a login that yields no access token", async () => {
    vi.spyOn(adminApi, "login").mockResolvedValue(result({ access_token: null }));

    renderWithProviders(<AdminLoginPage />);
    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot access the admin console/i);
    expect(push).not.toHaveBeenCalled();
    expect(tokens.access).toBeNull();
  });

  it("shows the server's message when sign-in fails", async () => {
    vi.spyOn(adminApi, "login").mockRejectedValue(new Error("Invalid credentials"));

    renderWithProviders(<AdminLoginPage />);
    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid credentials/i);
  });

  it("sends an already-signed-in super-admin straight to the dashboard", async () => {
    vi.spyOn(adminApi, "bootstrap").mockResolvedValue({
      id: "u1",
      email: "root@neubit",
      is_superadmin: true,
    } as User);

    renderWithProviders(<AdminLoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });
});
