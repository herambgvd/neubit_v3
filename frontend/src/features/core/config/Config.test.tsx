/**
 * Branding and Notifications were two Platform segments and one subject: the name,
 * colour and logo appear on the login page AND on every email that leaves here,
 * and the delivery channels are what carries those emails. They are one view now.
 *
 * The other rule here is the webhook channel's absence, and WHY. The console
 * stopped offering it because nothing in the product ever sends one — not because
 * the ingest service replaced it. Ingest webhooks are INBOUND (external systems
 * POST into `/ingest/hooks/{slug}`); this channel was OUTBOUND. Opposite
 * directions, so one could never have covered the other.
 */
import { screen } from "@testing-library/react";
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
  it("holds both halves of the job — identity and delivery — on one page", async () => {
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText("Identity")).toBeInTheDocument();
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    // Branding's own field, and a delivery channel, without a tab in between.
    expect(await screen.findByDisplayValue("Acme")).toBeInTheDocument();
    expect(await screen.findByText("Email (SMTP)")).toBeInTheDocument();
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
