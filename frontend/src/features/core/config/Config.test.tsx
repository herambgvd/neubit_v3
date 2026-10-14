/**
 * Branding and Notifications were two Platform segments and one subject: the name,
 * colour and logo appear on the login page AND on every email that leaves here,
 * and the delivery channels are what carries those emails. They are one view now.
 * The per-user Appearance card is NOT here: it lives in My account → Preferences
 * only, so one setting is on one page.
 *
 * These cases key off the cards' own CONTENT, not off section headings. The first
 * version asserted two headings I had written above the cards; the headings were
 * dropped and the test broke while the view was perfectly fine — it had been
 * testing my labels rather than the merge.
 *
 * The other rule here is the webhook channel's absence, and WHY. The console
 * stopped offering it because nothing in the product ever sends one — not because
 * the ingest service replaced it. Ingest webhooks are INBOUND (external systems
 * POST into `/ingest/hooks/{slug}`); this channel was OUTBOUND. Opposite
 * directions, so one could never have covered the other.
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import ConfigPage from "./Config";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "me" }, can: () => true, hasModule: () => true }),
}));

const CHANNELS = [
  { channel: "email", enabled: true, config: { host: "smtp.example.com" } },
  { channel: "push", enabled: false, config: {} },
  // Still reported by core — the transport exists there — and still not offered.
  { channel: "webhook", enabled: true, config: { url: "https://hooks.example.com" } },
];

beforeEach(() => {
  stubApi({
    "GET /branding": { app_name: "Acme", primary_color: "#4f46e5", accent_color: "#22d3ee", name_in_header: true },
    "GET /messaging/channels": CHANNELS,
  });
});

describe("the Config view", () => {
  it("holds branding and delivery on one page", async () => {
    renderWithProviders(<ConfigPage />);

    // Branding's own field and a delivery channel — without a tab in between.
    expect(await screen.findByDisplayValue("Acme")).toBeInTheDocument();
    expect(await screen.findByText("Email (SMTP)")).toBeInTheDocument();
  });

  it("leaves the per-user appearance settings to My account", async () => {
    renderWithProviders(<ConfigPage />);

    // Theme, typeface and text size are the signed-in operator's: one setting,
    // one page, and not one an admin could read as platform-wide.
    await screen.findByText("Email (SMTP)");
    expect(screen.queryByText(/Applies to this browser straight away/i)).not.toBeInTheDocument();
  });

  it("does not offer the webhook channel, even though the backend still reports it", async () => {
    renderWithProviders(<ConfigPage />);

    await screen.findByText("Email (SMTP)");
    expect(screen.queryByText(/webhook/i)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("https://hooks.example.com")).not.toBeInTheDocument();
  });

  it("still offers the channels that do deliver", async () => {
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText("Email (SMTP)")).toBeInTheDocument();
    expect(screen.getByText("Push (FCM)")).toBeInTheDocument();
  });
});

/**
 * The delivery cards flow in balanced columns, and the per-user Appearance card
 * is not among them — it is a personal setting and lives in My account only.
 */
describe("the delivery flow", () => {
  // The page has TWO of these flows now — branding's and the delivery one — so
  // this anchors on a card that is only ever in the second. Selecting the first
  // match broke the moment branding became a flow too, which is the right kind of
  // break: the test was addressing the layout by position rather than by content.
  const flow = () => screen.getByText("Email (SMTP)").closest(".lg\\:columns-2");

  it("holds the delivery channels and not the per-user appearance settings", async () => {
    renderWithProviders(<ConfigPage />);
    await screen.findByText("Email (SMTP)");

    const el = flow();
    expect(el, "the delivery flow").not.toBeNull();
    // email + push, balanced across the columns by the browser.
    expect(el!.children).toHaveLength(2);
    expect(screen.queryByText("Typeface")).not.toBeInTheDocument();
  });

  it("keeps each card whole across the column break", async () => {
    renderWithProviders(<ConfigPage />);
    await screen.findByText("Email (SMTP)");

    // Without this the browser will split a card mid-field at the boundary.
    expect(flow()).toHaveClass("[&>*]:break-inside-avoid");
  });
});
