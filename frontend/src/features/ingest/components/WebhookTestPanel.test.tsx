/**
 * The dry-run panel exists so an operator can find out whether a payload would
 * be accepted BEFORE a vendor starts sending. That is only worth anything if it
 * reports the BACKEND's verdict: a run that completed and a payload that would
 * be published are different facts, and a panel that renders "done" for both is
 * worse than no panel — it certifies a webhook that rejects everything.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import WebhookTestPanel from "./WebhookTestPanel";
import { ingest as ingestApi } from "../api";
import type { WebhookTestResponse } from "../types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function verdict(over: Partial<WebhookTestResponse> = {}): WebhookTestResponse {
  return {
    schema_valid: true,
    schema_errors: [],
    transformed: { title: "Door forced" },
    transform_errors: [],
    would_publish: true,
    reject_reason: null,
    would_publish_subject: "iot.vendor.acme.alarm",
    auth_type: "none",
    resolved_event_type: "alarm.forced",
    matched_rule_id: null,
    matched_rule_name: null,
    device_lookup_value: null,
    resolved_device_id: null,
    ...over,
  };
}

function renderPanel() {
  renderWithProviders(<WebhookTestPanel hookId="wh1" />);
  return userEvent.setup();
}

const run = () => screen.getByRole("button", { name: /run test/i });

describe("a dry run", () => {
  it("reports the backend's schema verdict, not merely that the call succeeded", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(
      verdict({ schema_valid: false, schema_errors: ["'severity' is a required property"] }),
    );
    const user = renderPanel();

    await user.click(run());

    expect(await screen.findByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText(/'severity' is a required property/)).toBeInTheDocument();
    expect(screen.queryByText("Valid")).not.toBeInTheDocument();
  });

  it("says Valid only when the backend said the schema passed", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict());
    const user = renderPanel();

    await user.click(run());

    expect(await screen.findByText("Valid")).toBeInTheDocument();
  });

  it("surfaces a transform failure separately from a schema failure", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(
      verdict({ transformed: null, transform_errors: ["invalid JMESPath: event..name"] }),
    );
    const user = renderPanel();

    await user.click(run());

    expect(await screen.findByText(/invalid JMESPath: event\.\.name/)).toBeInTheDocument();
    // The schema was fine; only the transform was not.
    expect(screen.getByText("Valid")).toBeInTheDocument();
  });

  it("shows the subject the event would land on, so routing is checkable", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict());
    const user = renderPanel();

    await user.click(run());

    expect(await screen.findByText(/iot\.vendor\.acme\.alarm/)).toBeInTheDocument();
  });

  it("shows the transformed payload the receiver would actually publish", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(
      verdict({ transformed: { title: "Door forced", priority: "high" } }),
    );
    const user = renderPanel();

    await user.click(run());

    const out = await screen.findByText(/"priority": "high"/);
    expect(out).toHaveTextContent('"title": "Door forced"');
  });

  it("prints an em dash rather than 'null' when nothing was transformed", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict({ transformed: null }));
    const user = renderPanel();

    await user.click(run());

    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
  });

  it("sends the pasted sample verbatim as the payload", async () => {
    const test = vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict());
    const user = renderPanel();

    const box = screen.getByRole("textbox");
    await user.clear(box);
    await user.type(box, '{{"a":1}');
    await user.click(run());

    await waitFor(() => expect(test).toHaveBeenCalledWith("wh1", { a: 1 }));
  });
});

describe("a sample that is not JSON", () => {
  it("is refused here rather than sent for the backend to reject", async () => {
    const test = vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict());
    const user = renderPanel();

    const box = screen.getByRole("textbox");
    await user.clear(box);
    await user.type(box, "not json");
    await user.click(run());

    expect(await screen.findByText(/sample must be valid JSON/i)).toBeInTheDocument();
    expect(test).not.toHaveBeenCalled();
  });

  it("stops complaining the moment the operator edits the sample", async () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict());
    const user = renderPanel();

    const box = screen.getByRole("textbox");
    await user.clear(box);
    await user.type(box, "not json");
    await user.click(run());
    expect(await screen.findByText(/sample must be valid JSON/i)).toBeInTheDocument();

    await user.type(box, "x");

    expect(screen.queryByText(/sample must be valid JSON/i)).not.toBeInTheDocument();
  });
});

describe("before anything has been run", () => {
  it("shows no verdict at all, rather than an optimistic one", () => {
    vi.spyOn(ingestApi.webhooks, "test").mockResolvedValue(verdict());
    renderPanel();

    expect(screen.queryByText("Valid")).not.toBeInTheDocument();
    expect(screen.queryByText("Invalid")).not.toBeInTheDocument();
  });
});
