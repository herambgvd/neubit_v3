import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { LoginSession } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import SecurityPage from "./page";

function session(over: Partial<LoginSession> = {}): LoginSession {
  return {
    id: "s1",
    user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120",
    ip: "10.0.0.4",
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: "2026-01-02T03:04:05Z",
    current: false,
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(adminApi, "twoFactorStatus").mockResolvedValue({
    enabled: false,
    recovery_codes_remaining: 0,
  });
  vi.spyOn(adminApi, "listSessions").mockResolvedValue([
    session({ id: "s0", current: true }),
    session(),
  ]);
});

describe("two-factor enrolment", () => {
  it("shows the QR and the manual key, then the recovery codes on confirm", async () => {
    vi.spyOn(adminApi, "twoFactorSetup").mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauth_uri: "otpauth://totp/neubit:root?secret=JBSWY3DPEHPK3PXP",
    });
    const confirm = vi
      .spyOn(adminApi, "twoFactorConfirm")
      .mockResolvedValue({ recovery_codes: ["aaaa-bbbb", "cccc-dddd"] });

    renderWithProviders(<SecurityPage />);
    await userEvent.click(await screen.findByRole("button", { name: /enable 2fa/i }));

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/verification code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledWith("123456"));
    // The codes are shown once and never again, so they must actually render.
    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    expect(screen.getByText("cccc-dddd")).toBeInTheDocument();
  });

  it("will not submit an empty verification code", async () => {
    vi.spyOn(adminApi, "twoFactorSetup").mockResolvedValue({
      secret: "S",
      otpauth_uri: "otpauth://totp/x",
    });
    const confirm = vi.spyOn(adminApi, "twoFactorConfirm");

    renderWithProviders(<SecurityPage />);
    await userEvent.click(await screen.findByRole("button", { name: /enable 2fa/i }));

    expect(await screen.findByRole("button", { name: /verify/i })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows the remaining recovery codes once 2FA is on", async () => {
    vi.spyOn(adminApi, "twoFactorStatus").mockResolvedValue({
      enabled: true,
      recovery_codes_remaining: 7,
    });

    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText(/7 recovery codes remaining/i)).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("requires a code to disable 2FA", async () => {
    vi.spyOn(adminApi, "twoFactorStatus").mockResolvedValue({
      enabled: true,
      recovery_codes_remaining: 3,
    });
    const disable = vi.spyOn(adminApi, "twoFactorDisable").mockResolvedValue({});

    renderWithProviders(<SecurityPage />);
    await userEvent.click(await screen.findByRole("button", { name: /disable/i }));

    const submit = await screen.findByRole("button", { name: /disable 2fa/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/authenticator or recovery code/i), "654321");
    await userEvent.click(submit);

    await waitFor(() => expect(disable).toHaveBeenCalledWith("654321"));
  });
});

describe("password change", () => {
  it("rejects a mismatched confirmation before calling the API", async () => {
    const changePassword = vi.spyOn(adminApi, "changePassword");

    renderWithProviders(<SecurityPage />);
    await userEvent.type(await screen.findByLabelText(/current password/i), "old-secret");
    await userEvent.type(screen.getByLabelText(/^new password/i), "new-secret-1");
    await userEvent.type(screen.getByLabelText(/confirm new password/i), "different-1");
    await userEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("rejects a new password under eight characters", async () => {
    const changePassword = vi.spyOn(adminApi, "changePassword");

    renderWithProviders(<SecurityPage />);
    await userEvent.type(await screen.findByLabelText(/current password/i), "old-secret");
    await userEvent.type(screen.getByLabelText(/^new password/i), "short");
    await userEvent.type(screen.getByLabelText(/confirm new password/i), "short");
    await userEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });
});

describe("sessions", () => {
  it("marks the current device and offers no way to revoke it", async () => {
    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText(/this device/i)).toBeInTheDocument();
    // Two sessions, one of them current — so exactly one Revoke button.
    expect(screen.getAllByRole("button", { name: /^revoke$/i })).toHaveLength(1);
  });

  it("revokes another device by id", async () => {
    const revokeSession = vi.spyOn(adminApi, "revokeSession").mockResolvedValue({});

    renderWithProviders(<SecurityPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));

    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith("s1"));
  });

  it("confirms before signing out every other device", async () => {
    const revokeOthers = vi.spyOn(adminApi, "revokeOtherSessions").mockResolvedValue({});

    renderWithProviders(<SecurityPage />);
    await userEvent.click(await screen.findByRole("button", { name: /sign out others/i }));

    expect(await screen.findByText(/every session except this one/i)).toBeInTheDocument();
    expect(revokeOthers).not.toHaveBeenCalled();

    // Scope to the dialog: the card's own button sits behind the modal, which
    // Radix makes pointer-events:none.
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: /sign out others/i }));

    await waitFor(() => expect(revokeOthers).toHaveBeenCalled());
  });

  it("names the device from its user agent", async () => {
    renderWithProviders(<SecurityPage />);

    expect((await screen.findAllByText(/chrome · macos/i)).length).toBe(2);
  });
});
