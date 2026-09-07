/**
 * Config → Security is composed entirely out of permission checks: two different
 * permissions admit two different sets of cards, and neither admits the other's.
 * Getting that wrong exposes the directory bind settings to an approver, or hides
 * the dual-authorization queue from the person who has to clear it.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import SecurityPage from "./Security";

let perms: string[] = [];

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "me" },
    can: (p: string) => perms.includes("*") || perms.includes(p),
    hasModule: () => true,
  }),
}));

beforeEach(() => {
  perms = [];
  stubApi({
    "GET /security/policy": { require_2fa: false, require_2fa_roles: [], session_idle_minutes: 30 },
    "GET /security/directory": null,
    "GET /security/sso": null,
    "GET /security/dual-auth": { items: [], total: 0, page: 1, page_size: 20 },
    "GET /auth/roles": { items: [], total: 0, page: 1, page_size: 20 },
  });
});

describe("an operator with neither security permission", () => {
  it("gets a stated refusal rather than an empty-looking page", async () => {
    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText(/security settings are restricted/i)).toBeInTheDocument();
    expect(screen.queryByText(/two-factor authentication policy/i)).not.toBeInTheDocument();
  });
});

describe("an operator who may only approve", () => {
  it("sees the dual-authorization queue and none of the configuration cards", async () => {
    perms = ["dualauth.approve"];

    renderWithProviders(<SecurityPage />);

    // The bind password and OIDC client secret live behind security.manage.
    expect(screen.queryByText("LDAP / Active Directory")).not.toBeInTheDocument();
    expect(screen.queryByText("Single sign-on (OIDC)")).not.toBeInTheDocument();
    expect(screen.queryByText(/two-factor authentication policy/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/second approver/i)).toBeInTheDocument();
  });
});

describe("an operator who may manage security", () => {
  it("sees the policy, directory and single sign-on cards", async () => {
    perms = ["security.manage"];

    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText("Two-factor authentication policy")).toBeInTheDocument();
    expect(screen.getByText("LDAP / Active Directory")).toBeInTheDocument();
    expect(screen.getByText("Single sign-on (OIDC)")).toBeInTheDocument();
  });
});

/**
 * PROGRESSIVE DISCLOSURE. Directory and SSO each carry a dozen inputs, an
 * attribute mapper and a role-map editor. Rendered unconditionally, a tenant
 * using neither met two long forms for two features that are off — which is what
 * made this screen read as bloated.
 *
 * The rule: the switch and a one-line summary always show; the form shows when
 * the feature is ON, or when an admin asks for it. Collapsing must not HIDE
 * state, so the summary says whether it is configured.
 */
describe("the security cards disclose progressively", () => {
  beforeEach(() => {
    perms = ["security.manage"];
  });

  it("shows the switch but not the form while a feature is off and unconfigured", async () => {
    stubApi({
      "GET /security/policy": { require_2fa: false, require_2fa_roles: [] },
      "GET /security/directory": null,
      "GET /security/sso": null,
      "GET /security/dual-auth": { items: [], total: 0, page: 1, page_size: 20 },
      "GET /auth/roles": { items: [], total: 0, page: 1, page_size: 20 },
    });
    renderWithProviders(<SecurityPage />);

    expect(await screen.findByRole("switch", { name: /enable directory sync/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Server URI")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Issuer URL")).not.toBeInTheDocument();
  });

  it("reveals the form when the operator turns the feature on", async () => {
    stubApi({
      "GET /security/policy": { require_2fa: false, require_2fa_roles: [] },
      "GET /security/directory": null,
      "GET /security/sso": null,
      "GET /security/dual-auth": { items: [], total: 0, page: 1, page_size: 20 },
      "GET /auth/roles": { items: [], total: 0, page: 1, page_size: 20 },
    });
    renderWithProviders(<SecurityPage />);

    await userEvent.click(await screen.findByRole("switch", { name: /enable directory sync/i }));

    expect(await screen.findByLabelText("Server URI")).toBeInTheDocument();
    // Turning the directory on must not open SSO too.
    expect(screen.queryByLabelText("Issuer URL")).not.toBeInTheDocument();
  });

  it("says a disabled feature is still CONFIGURED rather than hiding that", async () => {
    stubApi({
      "GET /security/policy": { require_2fa: false, require_2fa_roles: [] },
      "GET /security/directory": {
        enabled: false,
        name: "Corp AD",
        server_uri: "ldaps://ad.example.com:636",
        base_dn: "dc=example,dc=com",
        group_role_map: {},
      },
      "GET /security/sso": null,
      "GET /security/dual-auth": { items: [], total: 0, page: 1, page_size: 20 },
      "GET /auth/roles": { items: [], total: 0, page: 1, page_size: 20 },
    });
    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText(/Configured — ldaps:\/\/ad\.example\.com:636, currently off/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Server URI")).not.toBeInTheDocument();
  });

  it("lets an admin open the settings of a feature that is off", async () => {
    stubApi({
      "GET /security/policy": { require_2fa: false, require_2fa_roles: [] },
      "GET /security/directory": { enabled: false, server_uri: "ldaps://ad", group_role_map: {} },
      "GET /security/sso": null,
      "GET /security/dual-auth": { items: [], total: 0, page: 1, page_size: 20 },
      "GET /auth/roles": { items: [], total: 0, page: 1, page_size: 20 },
    });
    renderWithProviders(<SecurityPage />);

    await userEvent.click((await screen.findAllByRole("button", { name: "Show settings" }))[0]);

    expect(await screen.findByLabelText("Server URI")).toBeInTheDocument();
  });
});
