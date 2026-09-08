/**
 * Email Templates is a 30:70 master/detail, and the two things worth pinning are
 * the ones that were wrong as modals.
 *
 * SWITCHING TEMPLATES MUST NOT CARRY A DRAFT. The editor holds unsaved state; the
 * pane is keyed on the template name so it remounts, because leaking one
 * template's body into another is the worst thing this screen could do.
 *
 * REVERT ONLY EXISTS WHERE THERE IS AN OVERRIDE. `DELETE /templates/{name}` 404s
 * when the caller has none, so offering it on a default template would be an
 * action that cannot succeed.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import EmailTemplatesPage from "./EmailTemplates";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "me" }, can: () => true, hasModule: () => true }),
}));

const LIST = [
  { name: "welcome", overridden: true, subject: "Welcome to Acme" },
  { name: "alert", overridden: false, subject: "Alert fired" },
];

const DETAIL: Record<string, unknown> = {
  welcome: { name: "welcome", subject: "Welcome to Acme", html: "<p>hi</p>", is_override: true },
  alert: { name: "alert", subject: "Alert fired", html: "<p>alert</p>", is_override: false },
};

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /messaging/templates": LIST,
    "GET /messaging/templates/welcome": DETAIL.welcome,
    "GET /messaging/templates/alert": DETAIL.alert,
    "GET /messaging/templates/welcome/preview": { subject: "Welcome to Acme", html: "<h1>rendered</h1>" },
    "PUT /messaging/templates/welcome": DETAIL.welcome,
    "DELETE /messaging/templates/welcome": { name: "welcome", reverted: true },
  });
});

describe("the templates library", () => {
  it("lists every template and opens the first one", async () => {
    renderWithProviders(<EmailTemplatesPage />);

    expect(await screen.findByRole("button", { name: /Welcome/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alert/ })).toBeInTheDocument();
    // The first is open: its body is in the editor.
    expect(await screen.findByDisplayValue("<p>hi</p>")).toBeInTheDocument();
  });

  it("does not carry an unsaved draft into another template", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    const body = await screen.findByDisplayValue("<p>hi</p>");

    await userEvent.clear(body);
    await userEvent.type(body, "<p>DRAFT</p>");
    await userEvent.click(screen.getByRole("button", { name: /Alert/ }));

    expect(await screen.findByDisplayValue("<p>alert</p>")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("<p>DRAFT</p>")).not.toBeInTheDocument();
  });

  it("reports a failed load instead of an empty library", async () => {
    stub.set({ "GET /messaging/templates": () => httpError(503, "messaging is down") });
    renderWithProviders(<EmailTemplatesPage />);

    expect(await screen.findByText(/messaging is down/i)).toBeInTheDocument();
    expect(screen.queryByText("No templates")).not.toBeInTheDocument();
  });
});

describe("editing one template", () => {
  it("saves the subject and body to that template's own endpoint", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    const body = await screen.findByDisplayValue("<p>hi</p>");

    await userEvent.clear(body);
    await userEvent.type(body, "<p>new</p>");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(stub.body("PUT /messaging/templates/welcome")).toEqual({
      subject: "Welcome to Acme",
      html: "<p>new</p>",
    });
  });

  it("leaves Save disabled until something actually changed", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("<p>hi</p>");

    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });

  it("offers Revert on an overridden template and not on a default one", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("<p>hi</p>");
    expect(screen.getByRole("button", { name: /revert to default/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Alert/ }));
    await screen.findByDisplayValue("<p>alert</p>");

    expect(screen.queryByRole("button", { name: /revert to default/i })).not.toBeInTheDocument();
  });
});

describe("seeing what it looks like", () => {
  it("renders the server's email in a sandboxed frame", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("<p>hi</p>");

    await userEvent.click(screen.getByRole("tab", { name: /preview/i }));

    const frame = (await screen.findByTitle("Email preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toContain("rendered");
    // No `allow-same-origin`: stored HTML must not reach this page.
    expect(frame.getAttribute("sandbox")).toBe("");
  });

  it("does not render the email until the preview is actually opened", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("<p>hi</p>");

    expect(stub.matching("GET /messaging/templates/welcome/preview")).toHaveLength(0);
  });

  it("says the preview is the SAVED template while there are unsaved edits", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    const body = await screen.findByDisplayValue("<p>hi</p>");
    await userEvent.type(body, "x");

    await userEvent.click(screen.getByRole("tab", { name: /preview/i }));

    expect(await screen.findByText(/Save your changes to see them here/i)).toBeInTheDocument();
  });
});
