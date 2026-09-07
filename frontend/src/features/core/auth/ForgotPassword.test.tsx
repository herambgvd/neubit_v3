/**
 * Password reset is two posts with two different bodies, and the second one is
 * the field name the backend actually reads (`new_password`, not `password`).
 * These pin both bodies and the emailed-link shortcut into step two.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";

import ForgotPasswordPage from "./ForgotPassword";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

let stub: ApiStub;

/** The page reads ?token= off window.location rather than useSearchParams. */
function stubSearch(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/forgot-password", search, href: "" },
  });
}

beforeEach(() => {
  push.mockClear();
  stubSearch("");
  stub = stubApi({
    "POST /auth/forgot-password": {},
    "POST /auth/reset-password": {},
  });
});

describe("requesting a reset", () => {
  it("asks for a token by email address alone", async () => {
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByPlaceholderText("you@company.com"), "ops@acme.com");

    await userEvent.click(screen.getByRole("button", { name: /send reset token/i }));

    await waitFor(() => expect(stub.matching("POST /auth/forgot-password")).toHaveLength(1));
    expect(stub.body("POST /auth/forgot-password")).toEqual({ email: "ops@acme.com" });
  });

  it("moves on to the token step whether or not the account existed", async () => {
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByPlaceholderText("you@company.com"), "nobody@acme.com");

    await userEvent.click(screen.getByRole("button", { name: /send reset token/i }));

    // Confirming which addresses exist would be an enumeration oracle.
    expect(await screen.findByPlaceholderText("paste token from email")).toBeInTheDocument();
  });
});

describe("setting the new password", () => {
  it("sends the token with the field name the backend reads", async () => {
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByPlaceholderText("you@company.com"), "ops@acme.com");
    await userEvent.click(screen.getByRole("button", { name: /send reset token/i }));

    await userEvent.type(await screen.findByPlaceholderText("paste token from email"), "tok-9");
    await userEvent.type(screen.getByPlaceholderText("••••••••••••"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => expect(stub.matching("POST /auth/reset-password")).toHaveLength(1));
    expect(stub.body("POST /auth/reset-password")).toEqual({
      token: "tok-9",
      new_password: "hunter22",
    });
  });

  it("returns the operator to sign-in once the password is changed", async () => {
    stubSearch("?token=emailed-token");
    render(<ForgotPasswordPage />);

    await userEvent.type(await screen.findByPlaceholderText("••••••••••••"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });
});

describe("arriving from an emailed link", () => {
  it("opens on the token step with the token already filled in", async () => {
    stubSearch("?token=emailed-token");

    render(<ForgotPasswordPage />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("paste token from email")).toHaveValue("emailed-token")
    );
    expect(screen.queryByPlaceholderText("you@company.com")).not.toBeInTheDocument();
  });
});
