/**
 * The receiver URL and the delete button are the two things on this panel that
 * cost something when they are wrong.
 *
 * The URL is what an integrator is given, and it is built from `ingest_url` /
 * `slug`. It used to be gated on a `token` field the API has never sent, so the
 * row rendered no URL at all; these pin that it comes from the fields that
 * actually exist, and that the server's absolute URL wins when there is one.
 *
 * Deleting a webhook silently breaks whatever is posting to it, so nothing may
 * reach the API before the operator confirms.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import WebhooksPanel from "./WebhooksPanel";
import { ingest as ingestApi } from "../api";
import type { CategoryPublic, WebhookPublic } from "../types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const CATEGORY: CategoryPublic = {
  id: "c1",
  name: "Door vendors",
  description: null,
  target_domain: "vendor",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  webhook_count: 2,
};

function hook(over: Partial<WebhookPublic> = {}): WebhookPublic {
  return {
    id: "wh1",
    category_id: "c1",
    name: "Acme Doors",
    slug: "acme-doors",
    description: null,
    request_method: "post",
    auth_type: "hmac",
    auth_username: null,
    has_secret: true,
    payload_schema: {},
    transform: {},
    device_lookup_expr: null,
    event_type: "",
    is_active: true,
    ingest_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function listReturns(items: WebhookPublic[]) {
  return vi
    .spyOn(ingestApi.webhooks, "list")
    .mockResolvedValue({ items, total: items.length, skip: 0, limit: 100 });
}

const renderPanel = () => {
  renderWithProviders(<WebhooksPanel category={CATEGORY} catId="c1" />);
  return userEvent.setup();
};

/** jsdom has no clipboard; userEvent installs its own, so replace it per test. */
function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("the receiver URL an integrator is handed", () => {
  it("uses the server's absolute URL when the service knows its public origin", async () => {
    listReturns([hook({ ingest_url: "https://ingest.example.com/ingest/hooks/acme-doors" })]);

    renderPanel();

    expect(
      await screen.findByText("https://ingest.example.com/ingest/hooks/acme-doors"),
    ).toBeInTheDocument();
  });

  it("falls back to the SLUG — there is no token field and never was", async () => {
    listReturns([hook({ ingest_url: null, slug: "acme-doors" })]);

    renderPanel();

    expect(
      await screen.findByText(`${window.location.origin}/ingest/hooks/acme-doors`),
    ).toBeInTheDocument();
  });

  it("offers that same URL to the clipboard, not a different one", async () => {
    listReturns([hook({ ingest_url: "https://ingest.example.com/ingest/hooks/acme-doors" })]);
    const user = renderPanel();
    const writeText = stubClipboard();

    await user.click(await screen.findByTitle("Copy receiver URL"));

    expect(writeText).toHaveBeenCalledWith("https://ingest.example.com/ingest/hooks/acme-doors");
  });
});

describe("deleting a webhook", () => {
  it("does not call the API until the operator confirms", async () => {
    listReturns([hook()]);
    const remove = vi.spyOn(ingestApi.webhooks, "remove").mockResolvedValue(undefined);
    const user = renderPanel();

    await user.click(await screen.findByTitle("Delete"));

    expect(await screen.findByText(/delete webhook\?/i)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("wh1"));
  });

  it("leaves the webhook in place when the operator backs out", async () => {
    listReturns([hook()]);
    const remove = vi.spyOn(ingestApi.webhooks, "remove").mockResolvedValue(undefined);
    const user = renderPanel();

    await user.click(await screen.findByTitle("Delete"));
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/delete webhook\?/i)).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("what the row says about a webhook", () => {
  it("names the auth type in words rather than leaving the wire value on screen", async () => {
    listReturns([hook({ auth_type: "hmac" })]);

    renderPanel();

    expect(await screen.findByText(/HMAC signature/i)).toBeInTheDocument();
  });

  it("marks an inactive webhook as inactive, since it silently accepts nothing", async () => {
    listReturns([hook({ is_active: false })]);

    renderPanel();

    expect(await screen.findByText("Inactive")).toBeInTheDocument();
  });

  it("says the category has none rather than showing an empty list", async () => {
    listReturns([]);

    renderPanel();

    expect(await screen.findByText(/no webhooks yet/i)).toBeInTheDocument();
  });
});
