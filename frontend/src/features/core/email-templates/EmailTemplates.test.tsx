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
import { screen, within } from "@testing-library/react";
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
  welcome: {
    name: "welcome",
    subject: "Welcome to Acme",
    html: "<p>hi</p>",
    is_override: true,
    variables: ["app_name", "name"],
    is_builtin: true,
  },
  alert: {
    name: "alert",
    subject: "Alert fired",
    html: "<p>alert</p>",
    is_override: false,
    variables: ["app_name", "title"],
    is_builtin: true,
  },
};

let stub: ApiStub;

/** The raw-HTML editor lives behind its own tab now; Design is what opens first. */
async function openHtmlTab() {
  await screen.findByDisplayValue("Welcome to Acme");
  await userEvent.click(screen.getByRole("tab", { name: /^HTML$/i }));
  return screen.findByDisplayValue("<p>hi</p>");
}

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

    expect(await screen.findByRole("button", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alert" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Welcome to Acme")).toBeInTheDocument();
  });

  it("does not carry an unsaved draft into another template", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    const body = await openHtmlTab();

    await userEvent.clear(body);
    await userEvent.type(body, "DRAFT");
    await userEvent.click(screen.getByRole("button", { name: "Alert" }));

    expect(await screen.findByDisplayValue("Alert fired")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("DRAFT")).not.toBeInTheDocument();
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
    const body = await openHtmlTab();

    await userEvent.clear(body);
    await userEvent.type(body, "NEW");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(stub.body("PUT /messaging/templates/welcome")).toEqual({
      subject: "Welcome to Acme",
      html: "NEW",
    });
  });

  it("leaves Save disabled until something actually changed", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");

    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });

  it("enables Revert on an overridden template and disables it on a default one", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");
    expect(screen.getByRole("button", { name: /revert to default/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Alert" }));
    await screen.findByDisplayValue("Alert fired");

    expect(screen.getByRole("button", { name: /revert to default/i })).toBeDisabled();
  });
});

describe("seeing what it looks like", () => {
  it("renders the server's email in a sandboxed frame", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");

    await userEvent.click(screen.getByRole("tab", { name: /preview/i }));

    const frame = (await screen.findByTitle("Email preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toContain("rendered");
    // No `allow-same-origin`: stored HTML must not reach this page.
    expect(frame.getAttribute("sandbox")).toBe("");
  });

  it("does not render the email until the preview is actually opened", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");

    expect(stub.matching("GET /messaging/templates/welcome/preview")).toHaveLength(0);
  });

  it("says the preview is the SAVED template while there are unsaved edits", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    const body = await openHtmlTab();
    await userEvent.type(body, "x");

    await userEvent.click(screen.getByRole("tab", { name: /preview/i }));

    expect(await screen.findByText(/Save your changes to see them here/i)).toBeInTheDocument();
  });
});


/**
 * The visual designer, which exists because an operator cannot be asked to write
 * Jinja-in-HTML — and which must not pretend it can represent HTML it did not
 * produce.
 */
describe("the visual designer", () => {
  it("refuses to open foreign HTML as blocks, and says why", async () => {
    renderWithProviders(<EmailTemplatesPage />);

    // `<p>hi</p>` carries no designer marker.
    expect(await screen.findByText(/was not built in the designer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a design/i })).toBeInTheDocument();
  });

  it("opens a template the designer DID produce as its blocks", async () => {
    const designed = `<!--nb-blocks:${JSON.stringify([
      { id: "h", type: "heading", text: "Hello", level: 2, align: "left" },
    ])}--><h2>Hello</h2>`;
    stub.set({
      "GET /messaging/templates/welcome": { ...(DETAIL.welcome as object), html: designed },
    });
    renderWithProviders(<EmailTemplatesPage />);

    expect(await screen.findByDisplayValue("Hello")).toBeInTheDocument();
    expect(screen.queryByText(/was not built in the designer/i)).not.toBeInTheDocument();
  });

  it("writes the HTML from the blocks, so saving sends real markup", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByRole("button", { name: /start a design/i });

    await userEvent.click(screen.getByRole("button", { name: /start a design/i }));
    await userEvent.click(screen.getByRole("button", { name: "Heading" }));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const sent = stub.body("PUT /messaging/templates/welcome") as { html: string };
    expect(sent.html).toContain("<h2");
    // And the design travels with it, so reopening is exact rather than parsed.
    expect(sent.html).toContain("nb-blocks:");
  });

  it("offers the template's real placeholders, not a list it invented", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");

    // welcome is served `["app_name", "name"]`; `title` belongs to alert.
    expect(screen.getAllByRole("button", { name: "name" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "title" })).not.toBeInTheDocument();
  });

  it("lets a block be removed", async () => {
    const designed = `<!--nb-blocks:${JSON.stringify([
      { id: "h", type: "heading", text: "Hello", level: 2, align: "left" },
    ])}--><h2>Hello</h2>`;
    stub.set({
      "GET /messaging/templates/welcome": { ...(DETAIL.welcome as object), html: designed },
    });
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Hello");

    await userEvent.click(screen.getByRole("button", { name: /Remove Heading/i }));

    expect(screen.queryByDisplayValue("Hello")).not.toBeInTheDocument();
  });
});

describe("removing a template", () => {
  it("offers no row action on a template with nothing to undo", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByRole("button", { name: "Alert" });

    // `welcome` is overridden, `alert` is not — and DELETE 404s on a template
    // with no override, so a row action there would be one that cannot succeed.
    expect(screen.getByRole("button", { name: /Revert Welcome to default/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revert Alert to default/i })).not.toBeInTheDocument();
  });

  it("removes from the row, not only from the open template", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByRole("button", { name: "Welcome" });

    await userEvent.click(screen.getByRole("button", { name: /Revert Welcome to default/i }));

    expect(stub.matching("DELETE /messaging/templates/welcome")).toHaveLength(1);
  });


  it("calls it Revert on a built-in, because there is a default to fall back to", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");

    expect(screen.getByRole("button", { name: /revert to default/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /delete template/i })).not.toBeInTheDocument();
  });

  it("shows Revert DISABLED on a built-in that has no override, rather than hiding it", async () => {
    // A control that vanishes reads as a missing feature; one that is greyed with
    // a reason answers "where do I delete this". The endpoint 404s here, so it
    // must not be clickable either.
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Welcome to Acme");

    await userEvent.click(screen.getByRole("button", { name: "Alert" }));
    await screen.findByDisplayValue("Alert fired");

    const button = screen.getByRole("button", { name: /revert to default/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("nothing to revert"));
  });

  it("calls it Delete on a custom one, because nothing remains when it goes", async () => {
    stub.set({
      "GET /messaging/templates": [{ name: "custom_note", overridden: true, subject: "Note" }],
      "GET /messaging/templates/custom_note": {
        name: "custom_note",
        subject: "Note",
        html: "<p>x</p>",
        is_override: true,
        variables: ["app_name"],
        is_builtin: false,
      },
    });
    renderWithProviders(<EmailTemplatesPage />);
    await screen.findByDisplayValue("Note");

    expect(screen.getByRole("button", { name: /delete template/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revert to default/i })).not.toBeInTheDocument();
  });
});


describe("creating a template", () => {
  it("offers a New template control on the panel", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    expect(await screen.findByRole("button", { name: "New template" })).toBeInTheDocument();
  });

  it("says what will send the template it is about to create", async () => {
    // A custom template is delivered by whatever NAMES it — a linkage rule's
    // notify action. Saying so is the difference between designing an email and
    // designing one that goes nowhere.
    renderWithProviders(<EmailTemplatesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New template" }));

    expect(screen.getByText(/linkage rule/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing sends a custom template yet/i)).toBeNull();
  });

  it("refuses a name the sender could not address, and one already taken", async () => {
    renderWithProviders(<EmailTemplatesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New template" }));

    const name = within(screen.getByRole("dialog")).getByLabelText(/^Name/);
    await userEvent.type(name, "Bad Name/1");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText(/Lower-case letters, digits and underscores/i)).toBeInTheDocument();
    expect(stub.matching("PUT /messaging/templates/*")).toHaveLength(0);

    await userEvent.clear(name);
    await userEvent.type(name, "welcome");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
  });

  it("creates it as a DESIGN, so it opens in the designer rather than the refusal", async () => {
    stub.set({ "PUT /messaging/templates/maintenance_notice": { name: "maintenance_notice" } });
    renderWithProviders(<EmailTemplatesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New template" }));

    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "maintenance_notice");
    await userEvent.type(within(dialog).getByLabelText(/^Subject/), "Scheduled maintenance");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const sent = stub.body("PUT /messaging/templates/maintenance_notice") as {
      subject: string;
      html: string;
    };
    expect(sent.subject).toBe("Scheduled maintenance");
    expect(sent.html).toContain("nb-blocks:");
  });
});
