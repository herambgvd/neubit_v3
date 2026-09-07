/**
 * The System console is one page: a read-only posture band and an editable
 * settings band. The band that WRITES platform settings is gated on the
 * permission that authorises the write — being hidden from the nav is not a
 * control, since the URL is typeable.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import SystemPage from "./System";

const perms = { list: ["settings.manage", "security.manage", "user.read"] };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "me" },
    can: (p: string) => perms.list.includes(p),
    hasModule: () => true,
  }),
}));

beforeEach(() => {
  perms.list = ["settings.manage", "security.manage", "user.read"];
  stubApi({
    "GET /features": { license_state: "active", plan: "pro", modules: [], limits: {} },
    "GET /security/policy": { require_2fa: true, require_2fa_roles: [], session_idle_minutes: 15 },
    "GET /auth/users": { items: [{ id: "u1", totp_enabled: true }], total: 1 },
    "GET /security/dual-auth": { items: [], total: 0 },
    "GET /vms/evidence": { total: 0 },
    "GET /security/directory": null,
    "GET /security/sso": null,
    "GET /settings": {
      catalog: [
        { key: "announcement", type: "text", default: "", group: "General", label: "Announcement banner" },
      ],
      values: { announcement: "" },
    },
  });
});

describe("the System console", () => {
  it("shows the posture band and the settings band together — one page, no segment", async () => {
    renderWithProviders(<SystemPage />);

    expect(await screen.findByText("Posture")).toBeInTheDocument();
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(await screen.findByText("Announcement banner")).toBeInTheDocument();
  });

  it("hides the editable band from someone who may not write settings", async () => {
    perms.list = ["security.manage", "user.read"];
    renderWithProviders(<SystemPage />);

    expect(await screen.findByText("Posture")).toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
  });

  it("states nothing it did not measure — no 'AVAILABLE' or hardcoded crypto row", async () => {
    renderWithProviders(<SystemPage />);
    await screen.findByText("Posture");

    expect(screen.queryByText(/AVAILABLE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ed25519/)).not.toBeInTheDocument();
  });

  it("labels the MFA figure as a sample when it only counted a page of users", async () => {
    stubApi({
      "GET /features": { license_state: "active", modules: [] },
      "GET /security/policy": { require_2fa: true, require_2fa_roles: [] },
      "GET /auth/users": { items: [{ id: "u1", totp_enabled: true }], total: 400 },
      "GET /security/dual-auth": { items: [], total: 0 },
      "GET /vms/evidence": { total: 0 },
      "GET /security/directory": null,
      "GET /security/sso": null,
      "GET /settings": { catalog: [], values: {} },
    });
    renderWithProviders(<SystemPage />);

    expect(await screen.findByText(/sample — first 1 of 400 users/i)).toBeInTheDocument();
  });
});
