/**
 * The slug is the only field in ingest that an operator cannot take back: it IS
 * the last segment of the public receiver URL, the integrator is given that URL,
 * and the backend refuses to change it afterwards. Four properties follow, and
 * each has a distinct failure that is invisible until an integration breaks:
 *
 *   1. CREATE must carry `slug`. Without it the receiver has no address.
 *   2. It is SUGGESTED from the name only until the operator types their own —
 *      overwriting a hand-typed slug on the next keystroke of the name silently
 *      publishes a different URL than the one on screen a moment ago.
 *   3. Client validation is the backend's regex, verbatim, so a rejection here
 *      reads the same as one from the server.
 *   4. EDIT must NOT send it: `WebhookUpdate` has no slug and forbids extras, so
 *      a PATCH carrying one is a 422 on an otherwise valid save.
 *
 * And a 409 (the slug is globally unique) has to land on the field the operator
 * can actually change, with the rest of their form still in front of them.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import WebhookForm from "./WebhookForm";
import type { WebhookPublic } from "../types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const SAVED: WebhookPublic = {
  id: "wh1",
  category_id: "cat1",
  name: "Acme Door Events",
  slug: "acme-door-events",
  description: null,
  request_method: "post",
  auth_type: "none",
  auth_username: null,
  has_secret: false,
  payload_schema: {},
  transform: {},
  device_lookup_expr: null,
  event_type: "",
  is_active: true,
  ingest_url: "https://ingest.example.com/ingest/hooks/acme-door-events",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const nameBox = () => screen.getByPlaceholderText("Enter webhook name");
const slugBox = () => screen.getByPlaceholderText("acme-door-events");

let stub: ApiStub;
let onSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onSaved = vi.fn();
  stub = stubApi({
    "POST /ingest/webhooks": SAVED,
    "PATCH /ingest/webhooks/*": SAVED,
  });
});

function renderCreate() {
  renderWithProviders(
    <WebhookForm categoryId="cat1" webhook={null} onCancel={() => {}} onSaved={onSaved} />,
  );
  return userEvent.setup();
}

function renderEdit(webhook: WebhookPublic = SAVED) {
  renderWithProviders(
    <WebhookForm categoryId="cat1" webhook={webhook} onCancel={() => {}} onSaved={onSaved} />,
  );
  return userEvent.setup();
}

describe("creating a webhook", () => {
  it("sends the slug — the receiver has no address without it", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme Door Events");
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(stub.body("POST /ingest/webhooks")).toMatchObject({
      slug: "acme-door-events",
      category_id: "cat1",
      name: "Acme Door Events",
    });
  });

  it("suggests the slug from the name while the operator has not touched it", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme Door — Events!!");

    expect(slugBox()).toHaveValue("acme-door-events");
  });

  it("never overwrites a slug the operator typed themselves", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    await user.clear(slugBox());
    await user.type(slugBox(), "door-v2");
    // Renaming afterwards must not move the URL out from under them.
    await user.type(nameBox(), " Door Events");

    expect(slugBox()).toHaveValue("door-v2");

    await user.click(screen.getByRole("button", { name: /create webhook/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(stub.body("POST /ingest/webhooks")).toMatchObject({ slug: "door-v2" });
  });

  it("shows the receiver URL the slug will actually produce", async () => {
    const user = renderCreate();
    await user.type(slugBox(), "door-v2");

    expect(screen.getByText(new RegExp(`${window.location.origin}/ingest/hooks/door-v2`))).toBeInTheDocument();
  });
});

describe("the slug rule, which is the backend's regex verbatim", () => {
  const rejected: [string, string][] = [
    ["too short (two characters)", "ab"],
    ["uppercase", "Acme-Door"],
    ["a leading dash", "-acme"],
    ["a trailing dash", "acme-"],
    ["a leading underscore", "_acme"],
    ["a space", "acme door"],
    ["a slash", "acme/door"],
    ["a dot", "acme.door"],
  ];

  it.each(rejected)("refuses %s before anything is sent", async (_label, slug) => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    await user.clear(slugBox());
    await user.type(slugBox(), slug);
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    expect(await screen.findByText(/slug must be lowercase alphanumeric/i)).toBeInTheDocument();
    expect(stub.matching("POST /ingest/webhooks")).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  const accepted: [string, string][] = [
    ["three characters", "abc"],
    ["digits at both ends", "1acme2"],
    ["an interior underscore", "acme_door"],
    ["an interior dash", "acme-door-events"],
  ];

  it.each(accepted)("accepts %s", async (_label, slug) => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    await user.clear(slugBox());
    await user.type(slugBox(), slug);
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(stub.body("POST /ingest/webhooks")).toMatchObject({ slug });
  });

  it("says the slug is required rather than sending a nameless URL", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    await user.clear(slugBox());
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    expect(await screen.findByText(/slug is required/i)).toBeInTheDocument();
    expect(stub.matching("POST /ingest/webhooks")).toHaveLength(0);
  });

  it("clears the complaint as soon as the operator edits the slug", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    await user.clear(slugBox());
    await user.click(screen.getByRole("button", { name: /create webhook/i }));
    expect(await screen.findByText(/slug is required/i)).toBeInTheDocument();

    await user.type(slugBox(), "a");

    expect(screen.queryByText(/slug is required/i)).not.toBeInTheDocument();
  });
});

describe("editing a webhook", () => {
  it("shows the slug read-only, because the integrator already has that URL", () => {
    renderEdit();

    expect(slugBox()).toHaveValue("acme-door-events");
    expect(slugBox()).toHaveAttribute("readonly");
  });

  it("leaves the slug out of the PATCH, which forbids the field entirely", async () => {
    const user = renderEdit();
    await user.clear(nameBox());
    await user.type(nameBox(), "Acme Door Events v2");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = stub.body("PATCH /ingest/webhooks/*");
    expect(body).toMatchObject({ name: "Acme Door Events v2" });
    expect(body).not.toHaveProperty("slug");
    expect(body).not.toHaveProperty("category_id");
  });

  it("does not re-suggest a slug when the webhook is renamed", async () => {
    const user = renderEdit();
    await user.clear(nameBox());
    await user.type(nameBox(), "Something Completely Different");

    expect(slugBox()).toHaveValue("acme-door-events");
  });

  it("renders the server's absolute receiver URL rather than rebuilding one", () => {
    renderEdit();

    expect(
      screen.getByText("https://ingest.example.com/ingest/hooks/acme-door-events"),
    ).toBeInTheDocument();
  });
});

describe("a slug that is already taken", () => {
  it("is reported on the slug field and keeps the operator in the form", async () => {
    stub.set({ "POST /ingest/webhooks": () => httpError(409, "slug already in use", "CONFLICT") });
    const user = renderCreate();
    await user.type(nameBox(), "Acme Door Events");
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    // Everything they typed is still there to edit.
    expect(nameBox()).toHaveValue("Acme Door Events");
    expect(slugBox()).toHaveValue("acme-door-events");
  });

  it("does not blame the slug for a failure that has nothing to do with it", async () => {
    stub.set({ "POST /ingest/webhooks": () => httpError(500, "database is on fire") });
    const user = renderCreate();
    await user.type(nameBox(), "Acme Door Events");
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    await waitFor(() => expect(stub.matching("POST /ingest/webhooks")).toHaveLength(1));
    expect(screen.queryByText(/already taken/i)).not.toBeInTheDocument();
  });
});

describe("the rest of the create body", () => {
  it("refuses invalid JSON in the transform instead of sending a broken map", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    const transformBox = screen.getByPlaceholderText(/"title": "event.name"/);
    await user.type(transformBox, "{{not json");
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    expect(await screen.findByText(/transform must be a valid JSON object/i)).toBeInTheDocument();
    expect(stub.matching("POST /ingest/webhooks")).toHaveLength(0);
  });

  it("omits the secret entirely when the endpoint is open", async () => {
    const user = renderCreate();
    await user.type(nameBox(), "Acme");
    await user.click(screen.getByRole("button", { name: /create webhook/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = stub.body("POST /ingest/webhooks");
    expect(body).toMatchObject({ auth_type: "none" });
    expect(body).not.toHaveProperty("auth_secret");
  });
});
