/**
 * Branding and Notifications were two Platform segments and one subject: the name,
 * colour and logo appear on the login page AND on every email that leaves here,
 * and the delivery channels are what carries those emails. They are one view now,
 * with the per-user Appearance card alongside them.
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
  it("holds branding, delivery and appearance on one page", async () => {
    renderWithProviders(<ConfigPage />);

    // Branding's own field, a delivery channel, and the appearance picker —
    // without a tab in between.
    expect(await screen.findByDisplayValue("Acme")).toBeInTheDocument();
    expect(await screen.findByText("Email (SMTP)")).toBeInTheDocument();
    expect(screen.getByText("Typeface")).toBeInTheDocument();
  });

  it("says the appearance picker is the signed-in operator's, not the tenant's", async () => {
    renderWithProviders(<ConfigPage />);

    // The card carries its own scope; without that line an admin would read a
    // per-user setting on a platform page as platform-wide.
    expect(
      await screen.findByText(/Applies to this browser straight away/i),
    ).toBeInTheDocument();
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
 * Appearance flows WITH the delivery cards, not under them.
 *
 * A grid was the first attempt and it left the void it was meant to fix: every
 * cell in a grid row is as tall as the tallest, so the two short channel cards
 * had a band of dead space beneath them and the page ended unevenly. A column
 * flow lets the browser balance three cards of very different heights.
 */
describe("where the Appearance card sits", () => {
  const flow = (container: HTMLElement) => container.querySelector(".lg\\:columns-2");

  it("is one of the cards in the same flow as the delivery channels", async () => {
    const { container } = renderWithProviders(<ConfigPage />);
    await screen.findByText("Email (SMTP)");

    const el = flow(container);
    expect(el, "the delivery/appearance flow").not.toBeNull();
    // email + push + appearance, balanced across the columns by the browser.
    expect(el!.children).toHaveLength(3);
    expect(within(el as HTMLElement).getByText("Typeface")).toBeInTheDocument();
  });

  it("keeps each card whole across the column break", async () => {
    const { container } = renderWithProviders(<ConfigPage />);
    await screen.findByText("Email (SMTP)");

    // Without this the browser will split a card mid-field at the boundary.
    expect(flow(container)).toHaveClass("[&>*]:break-inside-avoid");
  });
});
