/**
 * The notify action's TEMPLATE field — the only place in the console that names
 * an email template for delivery.
 *
 * A custom template is otherwise a document nothing sends: core renders it, but
 * something has to reference it by name. That reference is written here, into the
 * rule's action config, so these assertions are about the CONFIG the builder
 * emits, not about the markup.
 *
 * The list needs settings.manage, which a rule editor may not hold, so a refused
 * or empty list must degrade to a typed name rather than removing the field.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { renderWithProviders } from "@/test/render";

import LinkageActionsBuilder from "./LinkageActionsBuilder";

const NOTIFY = [{ type: "notify", config: { channel: "email" } }];

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubTemplates(names: string[]) {
  return vi
    .spyOn(api, "get")
    .mockResolvedValue({ data: names.map((name) => ({ name, subject: name })) } as never);
}

describe("notify template field", () => {
  it("writes the chosen template name into the action config", async () => {
    stubTemplates(["alert", "gate_breach"]);
    const onChange = vi.fn();
    renderWithProviders(<LinkageActionsBuilder actions={NOTIFY} onChange={onChange} />);

    // The console's picker is a button + a portalled listbox, not a <select>.
    const trigger = await screen.findByRole("button", { name: "Email template" });
    // Explicitly, not by the wrapping <label>: a <label> names labelable elements
    // and this picker's trigger is a <button>, so a browser would announce it as
    // its selected value alone. (The name query alone cannot see the difference —
    // dom-accessibility-api is more generous than the spec.)
    expect(trigger.getAttribute("aria-label")).toBe("Email template");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "gate_breach" }));

    expect(onChange).toHaveBeenCalledWith([
      { type: "notify", config: { channel: "email", template: "gate_breach" } },
    ]);
  });

  it("hides the subject and body once a template is chosen", async () => {
    stubTemplates(["alert"]);
    renderWithProviders(
      <LinkageActionsBuilder actions={[{ type: "notify", config: { template: "alert" } }]} />,
    );
    await screen.findByLabelText("Email template");
    // The template IS the subject and the body; two sources of wording, one of
    // which silently loses, is the confusion this field exists to remove.
    expect(screen.queryByLabelText("Subject")).toBeNull();
    expect(screen.queryByLabelText("Body")).toBeNull();
  });

  it("offers subject and body when no template is chosen", async () => {
    stubTemplates(["alert"]);
    renderWithProviders(<LinkageActionsBuilder actions={NOTIFY} />);
    await screen.findByLabelText("Email template");
    expect(screen.getByLabelText("Subject")).toBeTruthy();
    expect(screen.getByLabelText("Body")).toBeTruthy();
  });

  it("degrades to a typed name when the template list is refused", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new Error("403"));
    const onChange = vi.fn();
    renderWithProviders(<LinkageActionsBuilder actions={NOTIFY} onChange={onChange} />);

    const field = await screen.findByLabelText("Email template");
    await waitFor(() => expect(field.tagName).toBe("INPUT"));
    // One keystroke: the builder is controlled by its parent, which is stubbed
    // here, so every keystroke patches from the same empty value.
    await userEvent.type(field, "g");
    expect(onChange).toHaveBeenLastCalledWith([
      { type: "notify", config: { channel: "email", template: "g" } },
    ]);
  });
});

describe("the wall-display action", () => {
  it("is offered at all", async () => {
    // The engine has executed `wall_display` since VW-C; the picker did not list
    // it, so the one action that drives the video WALL could not be configured.
    stubTemplates([]);
    renderWithProviders(<LinkageActionsBuilder actions={[{ type: "popup", config: {} }]} />);

    // The action-type picker is the console's button + portalled listbox; its
    // trigger reads the current action.
    await userEvent.click(await screen.findByRole("button", { name: /operator popup/i }));
    expect(await screen.findByRole("option", { name: /show on video wall/i })).toBeInTheDocument();
  });

  it("picks the wall and the monitor rather than asking for uuids", async () => {
    // A rule pointing at a wall that does not exist fails at FIRE time — in the
    // audit log, hours later, on an alarm nobody was watching.
    vi.spyOn(api, "get").mockImplementation((url: string) => {
      if (url.includes("/walls/") && url.includes("monitors")) {
        return Promise.resolve({ data: { items: [{ id: "m1", name: "Left screen", layout: 4 }] } }) as never;
      }
      if (url.includes("/walls")) {
        return Promise.resolve({ data: { items: [{ id: "w1", name: "Control room" }] } }) as never;
      }
      return Promise.resolve({ data: { items: [] } }) as never;
    });
    const onChange = vi.fn();
    renderWithProviders(
      <LinkageActionsBuilder actions={[{ type: "wall_display", config: {} }]} onChange={onChange} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Wall" }));
    await userEvent.click(await screen.findByRole("option", { name: "Control room" }));

    expect(onChange).toHaveBeenLastCalledWith([
      { type: "wall_display", config: { wall_id: "w1", monitor_id: "" } },
    ]);
  });

  it("clears the monitor when the wall changes", async () => {
    // A monitor belongs to ONE wall; carrying the id over points the action at a
    // monitor the new wall does not have.
    vi.spyOn(api, "get").mockImplementation((url: string) => {
      if (url.includes("monitors")) return Promise.resolve({ data: { items: [] } }) as never;
      if (url.includes("/walls")) {
        return Promise.resolve({
          data: { items: [{ id: "w1", name: "Control room" }, { id: "w2", name: "Lobby wall" }] },
        }) as never;
      }
      return Promise.resolve({ data: { items: [] } }) as never;
    });
    const onChange = vi.fn();
    renderWithProviders(
      <LinkageActionsBuilder
        actions={[{ type: "wall_display", config: { wall_id: "w1", monitor_id: "m9" } }]}
        onChange={onChange}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Wall" }));
    await userEvent.click(await screen.findByRole("option", { name: "Lobby wall" }));

    const last = onChange.mock.calls.at(-1)![0][0];
    expect(last.config.wall_id).toBe("w2");
    expect(last.config.monitor_id).toBe("");
  });
});
