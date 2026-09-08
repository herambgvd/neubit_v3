/**
 * Channels — where an incident notification actually goes out.
 *
 * The dispatcher has always read these rows. Nothing could write one, so every
 * send fell back to whatever `VE_SMTP_*` was in the service's environment, or
 * failed with "no SMTP host configured" and no way to fix it from the console.
 *
 * The two behaviours that must hold, because both destroy working delivery
 * quietly: a stored credential must survive an unrelated edit (it comes back
 * REDACTED and the form submits what it was given), and an untouched optional
 * field must not be stored as "" — a connector reads that as configured.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import ChannelsTab from "./ChannelsTab";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const EMAIL = {
  channel_id: "c1",
  name: "Ops mailbox",
  channel_type: "email",
  config: { host: "smtp.example.com", port: "587", username: "ops", password: "***REDACTED***" },
  is_enabled: true,
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const HOOK = { ...EMAIL, channel_id: "c2", name: "Ops hook", channel_type: "webhook", config: { url: "https://h" }, is_enabled: false, is_default: false };

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /workflow/notifications/channels": [EMAIL, HOOK],
    "POST /workflow/notifications/channels": EMAIL,
    "PATCH /workflow/notifications/channels/*": EMAIL,
    "DELETE /workflow/notifications/channels/*": {},
    ...over,
  });
  return stub;
}

beforeEach(() => stubAll());

describe("the list", () => {
  it("shows what is configured and which are enabled", async () => {
    renderWithProviders(<ChannelsTab />);

    expect(await screen.findAllByText("Ops mailbox")).not.toHaveLength(0);
    expect(screen.getByTitle("enabled")).toHaveTextContent("1");
    expect(screen.getByTitle("disabled")).toHaveTextContent("1");
  });

  it("reports a failed load rather than an unconfigured estate", async () => {
    // "No channels" tells an operator to add one. "We could not read them" means
    // notifications may be going out perfectly well.
    stubAll({ "GET /workflow/notifications/channels": () => httpError(503, "workflow is unreachable") });
    renderWithProviders(<ChannelsTab />);

    expect(await screen.findByText(/workflow is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no channels yet/i)).toBeNull();
  });

  it("says what happens with no channel at all", async () => {
    stubAll({ "GET /workflow/notifications/channels": [] });
    renderWithProviders(<ChannelsTab />);

    expect(await screen.findByText(/fall back to the service/i)).toBeInTheDocument();
  });
});

describe("editing a channel", () => {
  it("keeps a stored credential when something else is changed", async () => {
    // The password comes back redacted; submitting it unchanged is what tells
    // the service "keep the stored one". Sending "" would wipe it, and the next
    // send would fail authentication with nothing on screen to explain it.
    renderWithProviders(<ChannelsTab />);
    await screen.findAllByText("Ops mailbox");

    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const host = await screen.findByLabelText(/smtp host/i);
    await userEvent.clear(host);
    await userEvent.type(host, "smtp2.example.com");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(stub.matching("PATCH /workflow/notifications/channels/c1")).toHaveLength(1),
    );
    const body = stub.body("PATCH /workflow/notifications/channels/c1")!;
    const cfg = body.config as Record<string, string>;
    expect(cfg.host).toBe("smtp2.example.com");
    expect(cfg.password).toBe("***REDACTED***");
  });

  it("drops a field the operator cleared instead of storing an empty string", async () => {
    // A connector reads "" as configured — an empty from-address becomes a send
    // with no sender rather than a fallback to the default. Clearing a field has
    // to mean "unset", which is what the operator meant by clearing it.
    renderWithProviders(<ChannelsTab />);
    await screen.findAllByText("Ops mailbox");

    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const from = await screen.findByLabelText(/from address/i);
    await userEvent.type(from, "alerts@example.com");
    await userEvent.clear(from);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const cfg = stub.body("PATCH /workflow/notifications/channels/c1")!.config as Record<string, string>;
    expect("from_address" in cfg).toBe(false);
    // …and the fields that DO hold something still go.
    expect(cfg.host).toBe("smtp.example.com");
  });

  it("creates a channel with the type's own fields", async () => {
    renderWithProviders(<ChannelsTab />);
    await screen.findAllByText("Ops mailbox");

    await userEvent.click(screen.getByRole("button", { name: /new channel/i }));
    await userEvent.type(await screen.findByLabelText(/^name/i), "Night desk");
    await userEvent.type(screen.getByLabelText(/smtp host/i), "smtp.night");
    await userEvent.click(screen.getByRole("button", { name: /create channel/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/notifications/channels")).toHaveLength(1));
    const body = stub.body("POST /workflow/notifications/channels")!;
    expect(body.name).toBe("Night desk");
    expect(body.channel_type).toBe("email");
    expect((body.config as Record<string, string>).host).toBe("smtp.night");
  });

  it("asks before deleting one that notifications depend on", async () => {
    renderWithProviders(<ChannelsTab />);
    await screen.findAllByText("Ops mailbox");

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText(/fall back to the service environment/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /workflow/notifications/channels/c1")).toHaveLength(0);

    await userEvent.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);
    await waitFor(() =>
      expect(stub.matching("DELETE /workflow/notifications/channels/c1")).toHaveLength(1),
    );
  });
});
