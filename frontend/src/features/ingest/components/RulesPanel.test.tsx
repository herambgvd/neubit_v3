/**
 * Rules decide which payload becomes which event, in priority order, first match
 * wins. The list is the only place an operator sees what a rule actually
 * matches, so the one-line summary has to be true — a rule with NO conditions
 * matches EVERYTHING, and rendering that as a blank summary is how a catch-all
 * gets left above the rules it shadows.
 *
 * Deleting a rule stops recognising an event shape; it must be confirm-gated.
 * Toggling one must PATCH `enabled` and nothing else.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import RulesPanel from "./RulesPanel";
import { ingest as ingestApi } from "../api";
import type { EventRulePublic, MatchCondition } from "../types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function rule(over: Partial<EventRulePublic> = {}): EventRulePublic {
  return {
    id: "r1",
    webhook_id: "wh1",
    name: "Motion",
    description: null,
    priority: 10,
    match_conditions: [{ path: "alarm.type", op: "equals", value: "motion" }],
    field_map: {},
    event_type: "alarm.motion",
    target_domain: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function listReturns(items: EventRulePublic[]) {
  return vi.spyOn(ingestApi.eventRules, "list").mockResolvedValue({ items, total: items.length });
}

const renderPanel = () => {
  renderWithProviders(<RulesPanel webhookId="wh1" />);
  return userEvent.setup();
};

describe("the one-line summary of what a rule matches", () => {
  const cases: [string, MatchCondition[], RegExp][] = [
    [
      "a rule with no conditions says so in words, because it matches everything",
      [],
      /\(matches anything\)/,
    ],
    [
      "an equals condition shows the value it compares against",
      [{ path: "alarm.type", op: "equals", value: "motion" }],
      /alarm\.type = "motion"/,
    ],
    [
      "a not_equals condition reads as a negation, not as an equality",
      [{ path: "alarm.type", op: "not_equals", value: "motion" }],
      /alarm\.type ≠ "motion"/,
    ],
    [
      "an exists condition needs no value",
      [{ path: "device.mac", op: "exists" }],
      /device\.mac exists/,
    ],
    [
      "a not_exists condition reads as missing rather than as existing",
      [{ path: "device.mac", op: "not_exists" }],
      /device\.mac missing/,
    ],
    [
      "a contains condition says contains",
      [{ path: "alarm.tags", op: "contains", value: "night" }],
      /alarm\.tags contains "night"/,
    ],
    [
      "extra conditions are counted, never silently hidden",
      [
        { path: "alarm.type", op: "equals", value: "motion" },
        { path: "device.mac", op: "exists" },
        { path: "alarm.channel", op: "equals", value: 1 },
      ],
      /alarm\.type = "motion" \(\+2 more\)/,
    ],
  ];

  it.each(cases)("%s", async (_label, conditions, expected) => {
    listReturns([rule({ match_conditions: conditions })]);

    renderPanel();

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it("counts the conditions beside the summary so a catch-all is unmistakable", async () => {
    listReturns([rule({ match_conditions: [] })]);

    renderPanel();

    expect(await screen.findByText(/· 0 conditions/)).toBeInTheDocument();
  });

  it("uses the singular for exactly one condition", async () => {
    listReturns([rule()]);

    renderPanel();

    expect(await screen.findByText(/· 1 condition$/)).toBeInTheDocument();
  });
});

describe("deleting a rule", () => {
  it("does not call the API until the operator confirms", async () => {
    listReturns([rule()]);
    const remove = vi.spyOn(ingestApi.eventRules, "remove").mockResolvedValue(undefined);
    const user = renderPanel();

    await user.click(await screen.findByTitle("Delete"));

    expect(await screen.findByText(/delete rule\?/i)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("r1"));
  });

  it("leaves the rule alone when the operator backs out", async () => {
    listReturns([rule()]);
    const remove = vi.spyOn(ingestApi.eventRules, "remove").mockResolvedValue(undefined);
    const user = renderPanel();

    await user.click(await screen.findByTitle("Delete"));
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/delete rule\?/i)).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });

  it("warns that the event shape stops being recognised, naming the rule", async () => {
    listReturns([rule({ name: "Motion" })]);
    vi.spyOn(ingestApi.eventRules, "remove").mockResolvedValue(undefined);
    const user = renderPanel();

    await user.click(await screen.findByTitle("Delete"));

    expect(
      await screen.findByText(/Delete "Motion"\? Events of this type will stop being recognised/i),
    ).toBeInTheDocument();
  });
});

describe("toggling a rule", () => {
  it("patches only `enabled`, so nothing else about the rule is rewritten", async () => {
    listReturns([rule({ enabled: true })]);
    const update = vi.spyOn(ingestApi.eventRules, "update").mockResolvedValue(rule());
    const user = renderPanel();

    await user.click(await screen.findByTitle("Disable"));

    await waitFor(() => expect(update).toHaveBeenCalledWith("r1", { enabled: false }));
  });

  it("offers to enable a disabled rule rather than to disable it again", async () => {
    listReturns([rule({ enabled: false })]);
    const update = vi.spyOn(ingestApi.eventRules, "update").mockResolvedValue(rule());
    const user = renderPanel();

    await user.click(await screen.findByTitle("Enable"));

    await waitFor(() => expect(update).toHaveBeenCalledWith("r1", { enabled: true }));
  });
});

describe("a webhook with no rules", () => {
  it("explains the flat-field-map fallback rather than looking broken", async () => {
    listReturns([]);

    renderPanel();

    expect(await screen.findByText(/no event rules yet/i)).toBeInTheDocument();
    expect(screen.getByText(/uses its flat field map for every payload/i)).toBeInTheDocument();
  });
});
