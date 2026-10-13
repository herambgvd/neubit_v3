/**
 * THE ALERTS SWITCH (SCRUM-326): mute and unmute, pop-ups on and off, for every
 * alarm, one click from any page — and saved as the operator's own setting, so a
 * muted console can always be turned back on.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

let prefs: Record<string, unknown> = {};
const reload = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { preferences: prefs }, reload }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import EventAlertControl from "./EventAlertControl";

let stub: ApiStub;
beforeEach(() => {
  prefs = {};
  reload.mockClear();
  stub = stubApi({ "PATCH /auth/me/preferences": {} });
});

describe("the Alerts switch in the top bar", () => {
  it("says what the sound is doing before it is opened", () => {
    prefs = { event_alert_sound: false };
    renderWithProviders(<EventAlertControl />);
    expect(screen.getByRole("button", { name: /sound muted/i })).toBeInTheDocument();
  });

  it("mutes the sound as the operator's own setting", async () => {
    renderWithProviders(<EventAlertControl />);
    await userEvent.click(screen.getByRole("button", { name: /^alerts:/i }));
    await userEvent.click(screen.getByRole("switch", { name: "Alert sound" }));

    // Turning the sound off also ends any timed mute: the switch is the whole answer.
    await waitFor(() =>
      expect(stub.body("PATCH /auth/me/preferences")).toEqual({
        preferences: { event_alert_sound: false, event_alert_mute_until: null },
      }),
    );
    expect(reload).toHaveBeenCalled();
  });

  it("turns pop-ups back on — the way back the old mute never had", async () => {
    prefs = { event_alert_popup: false };
    renderWithProviders(<EventAlertControl />);
    await userEvent.click(screen.getByRole("button", { name: /^alerts:/i }));
    expect(screen.getByRole("switch", { name: "Alert pop-ups" })).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("switch", { name: "Alert pop-ups" }));

    await waitFor(() => expect(stub.body("PATCH /auth/me/preferences")).toEqual({ preferences: { event_alert_popup: true } }));
  });

  it("links to the full settings", async () => {
    renderWithProviders(<EventAlertControl />);
    await userEvent.click(screen.getByRole("button", { name: /^alerts:/i }));
    expect(screen.getByRole("link", { name: /more settings/i })).toHaveAttribute("href", "/account?tab=preferences");
  });
});

describe("a timed mute (SCRUM-326)", () => {
  it("mutes for a while rather than for good", async () => {
    renderWithProviders(<EventAlertControl />);
    await userEvent.click(screen.getByRole("button", { name: /^alerts:/i }));
    const before = Date.now();
    await userEvent.click(screen.getByRole("button", { name: "15 min" }));

    await waitFor(() => expect(stub.body("PATCH /auth/me/preferences")).toBeTruthy());
    const until = (stub.body("PATCH /auth/me/preferences") as { preferences: { event_alert_mute_until: number } }).preferences
      .event_alert_mute_until;
    expect(until - before).toBeGreaterThanOrEqual(15 * 60_000);
    expect(until - before).toBeLessThan(15 * 60_000 + 5_000);
  });

  it("says until when, and unmutes at once", async () => {
    prefs = { event_alert_mute_until: Date.now() + 30 * 60_000 };
    renderWithProviders(<EventAlertControl />);
    expect(screen.getByRole("button", { name: /sound muted until/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^alerts:/i }));
    await userEvent.click(screen.getByRole("button", { name: "Unmute now" }));

    await waitFor(() =>
      expect(stub.body("PATCH /auth/me/preferences")).toEqual({ preferences: { event_alert_mute_until: null } }),
    );
  });
});
