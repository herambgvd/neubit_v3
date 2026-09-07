/**
 * The sign-in screen is the one page every operator meets, and the only one where
 * being wrong is silent: a half-succeeded login routes into a console with no
 * session. These pin the three outcomes of POST /auth/login — refused, challenged,
 * and tokenless — plus the rule that an empty form never reaches the network.
 *
 * The real AuthProvider is used rather than a mocked useAuth: the 2FA exchange
 * IS the provider's two-call sequence, and stubbing it would test the stub.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { httpError, stubApi, type ApiStub } from "@/test/apiStub";

import LoginPage from "./Login";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

const ME = { id: "u1", email: "ops@acme", role: { permissions: ["*"] } };

let stub: ApiStub;

/** jsdom cannot navigate; a 401 makes the api layer assign window.location.href. */
function stubLocation() {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/login", href: "" },
  });
}

beforeEach(() => {
  tokens.clear();
  push.mockClear();
  replace.mockClear();
  stubLocation();
  stub = stubApi({
    "GET /auth/setup-status": { needs_setup: false },
    "GET /auth/me": ME,
    "GET /features": { modules: [], license_state: "active" },
    "POST /auth/logout": {},
  });
});

async function signIn(email = "ops@acme.com", password = "hunter22") {
  await screen.findByRole("button", { name: /sign in/i });
  await userEvent.type(screen.getByPlaceholderText("you@company.com"), email);
  await userEvent.type(screen.getByPlaceholderText("••••••••••"), password);
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

const renderLogin = () =>
  render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>
  );

describe("a refused sign-in", () => {
  it("shows the reason the server gave, not a generic failure", async () => {
    stub.set({ "POST /auth/login": () => httpError(401, "Account is locked — contact an administrator") });

    renderLogin();
    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account is locked — contact an administrator"
    );
    expect(push).not.toHaveBeenCalled();
  });

  // The backend answers a malformed payload with a 422 envelope that reads
  // "Request validation failed" — an operator cannot act on that.
  it("translates the backend's bare validation envelope into something actionable", async () => {
    stub.set({ "POST /auth/login": () => httpError(422, "Request validation failed") });

    renderLogin();
    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/check your email and password/i);
  });
});

describe("form validation", () => {
  it("refuses to post an empty form and names the field that is missing", async () => {
    renderLogin();
    await screen.findByRole("button", { name: /sign in/i });

    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/work email is required/i)).toBeInTheDocument();
    expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    expect(stub.matching("POST /auth/login")).toHaveLength(0);
  });

  it("refuses an address that is not an address, before the network sees it", async () => {
    renderLogin();
    await screen.findByRole("button", { name: /sign in/i });
    await userEvent.type(screen.getByPlaceholderText("you@company.com"), "ops@acme");
    await userEvent.type(screen.getByPlaceholderText("••••••••••"), "hunter22");

    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/enter a valid work email/i)).toBeInTheDocument();
    expect(stub.matching("POST /auth/login")).toHaveLength(0);
  });
});

describe("a two-factor challenge", () => {
  it("switches to the code step instead of signing anyone in", async () => {
    stub.set({ "POST /auth/login": { mfa_required: true, mfa_token: "challenge-1" } });

    renderLogin();
    await signIn();

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("you@company.com")).not.toBeInTheDocument();
    expect(tokens.access).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("exchanges the code against the challenge token the server issued", async () => {
    stub.set({
      "POST /auth/login": { mfa_required: true, mfa_token: "challenge-1" },
      "POST /auth/login/mfa": { access_token: "real-token" },
    });

    renderLogin();
    await signIn();
    await userEvent.type(await screen.findByPlaceholderText("123456"), "424242");
    await userEvent.click(screen.getByRole("button", { name: /verify and sign in/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/home"));
    expect(stub.body("POST /auth/login/mfa")).toEqual({
      mfa_token: "challenge-1",
      code: "424242",
    });
    expect(tokens.access).toBe("real-token");
  });

  it("keeps the operator on the code step when the code is wrong", async () => {
    stub.set({
      "POST /auth/login": { mfa_required: true, mfa_token: "challenge-1" },
      "POST /auth/login/mfa": () => httpError(401, "That code has expired"),
    });

    renderLogin();
    await signIn();
    await userEvent.type(await screen.findByPlaceholderText("123456"), "000000");
    await userEvent.click(screen.getByRole("button", { name: /verify and sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That code has expired");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("a login that issues no session", () => {
  // A 200 with no access_token used to toast "Signed in" and route to /home,
  // which bounced straight back to /login. Half-succeeding is worse than failing.
  it("is reported as a failure rather than routed into the console", async () => {
    stub.set({ "POST /auth/login": { mfa_required: false, access_token: null } });

    renderLogin();
    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no session was issued/i);
    expect(push).not.toHaveBeenCalled();
    expect(tokens.access).toBeNull();
  });
});

describe("a deployment with no users yet", () => {
  it("sends the visitor to the first-run wizard instead of an unusable form", async () => {
    stub.set({ "GET /auth/setup-status": { needs_setup: true } });

    renderLogin();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/setup"));
  });
});
